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

const WelcomeBanner = require('./WelcomeBanner');
const Transcript = require('./Transcript');
// TranscriptView 的工具行摘要复用 ToolLines 的 summarizeArgs,视图里的
// `✓ readFile(src/a.js)` 与 committed 区逐字一致(含相对路径/中间截断门控)。
const ToolLines = require('./ToolLines');
const StreamingBlock = require('./StreamingBlock');
const PromptFrame = require('./PromptFrame');
const KhyOsView = require('./KhyOsView');
const PlanApproval = require('./PlanApproval');
const Spinner = require('./Spinner');
const CompactionProgress = require('./CompactionProgress');
const CompletionMenu = require('./CompletionMenu');
const HelpMenu = require('./HelpMenu');
const ShellView = require('./ShellView');
const TranscriptView = require('./TranscriptView');
const TaskListPanel = require('./TaskListPanel');
// 独占输入的全屏覆盖层(/model·/khyos)期间隐藏输入框/页脚的判定单一真源。
const overlayLiveBudget = require('./overlayLiveBudget');
const TopologyPanel = require('./TopologyPanel');
const SidebarPanel = require('./SidebarPanel');
const { useQueryBridge, buildResumedTranscript } = require('../hooks/useQueryBridge');
const { useVimInput } = require('../hooks/useVimInput');
const { useCompletions, applyCompletion } = require('../hooks/useCompletions');
const { useTopic } = require('../hooks/useTopic');
const { useSidebarNav } = require('../hooks/useSidebarNav');
const topicBar = require('../runtime/topicBar');
const sidebarRail = require('../runtime/sidebarRail');
// 有效列宽单一真源:右栏激活时 ink 只能画到 cols - 栏宽。门控关 → 真实列宽 → legacy。
// 注意:resize 分类(classifyResize)、sidebarWidth/shouldShowSidebar 的入参、以及 Ctrl+T
// 窄屏提示里给用户看的列数要的是物理终端宽度 —— 现在统一经 stickyCols 读:仍是物理
// 宽度,只是 Windows conpty 帧间震荡(120 → undefined → 120)时沿用上一帧合法值,
// 不再跌回 fallback 导致整棵树反复重排(看板抖动/重影根因 B)。
const { effectiveCols: _railCols, stickyCols: _stickyCols } = require('../effectiveCols');
// Terminal-size fallback single source (zero-hardcode): Windows PowerShell /
// conpty can leave process.stdout.columns/rows undefined. Every dimension
// fallback below resolves through sidebarLayout.fallbackCols/fallbackRows so
// all frames agree on ONE assumed size — disagreeing local `|| 80` literals
// are what made the task board flicker between show and hide.
const sidebarLayout = require('../sidebarLayout');
const rewindControl = require('../rewindControl');
const pendingImageAttachments = require('../pendingImageAttachments');
const interruptHint = require('../interruptHint');
// 未知模型上下文窗口回退值的单一真源(纯常量叶) —— 显示分母与压缩预算共用同一个数。
const { UNKNOWN_MODEL_CONTEXT_WINDOW } = require('../../../constants/contextWindowDefaults');
const _sessionColorLeaf = require('../../sessionColor');
const _sessionColorState = require('../../sessionColorState');
// ↑/↓ history-browse decision while editing (pure leaf, single source + gate).
// footer identity equality (pure, single source of truth) — lets refreshFooter's
// setFooter return the SAME ref when nothing changed, so an adapterInfo churn can
// no longer force an unconditional re-render (the render-storm "loaded gun").
const { footersEqual } = require('../footerStability');
const inkRuntime = require('../inkRuntime');

// Live-region height coordinator (anti scroll-jump). Pure leaf; fail-soft require
// so a missing module byte-reverts to legacy reserves. Gate KHY_LIVE_HEIGHT_BUDGET.
let _liveBudget = null;
try {
  _liveBudget = require('./liveRegionBudget');
} catch {
  _liveBudget = null;
}
// CC-aligned chat/global key chords → action name (pure leaf, fail-soft require).
// Gate KHY_CHAT_CHORDS. Missing module / gate off → resolveChatChord yields null
// so the keys byte-revert to falling through to the text input. See chatChords.js.
let _chatChords = null;
try {
  _chatChords = require('../chatChords');
} catch {
  _chatChords = null;
}
// CC-aligned Ctrl+R reverse-incremental history search (pure leaf, fail-soft
// require). Gate KHY_HISTORY_REVERSE_SEARCH. Missing module / gate off →
// isEnabled false → the Ctrl+R branch never activates and the key byte-reverts
// to falling through to the text input. See services/keybindings/historyReverseSearch.js.
let _revSearch = null;
try {
  _revSearch = require('../../../services/keybindings/historyReverseSearch');
} catch {
  _revSearch = null;
}
// Windows Win+H voice dictation trigger (fail-soft require). Alt+M dispatches
// triggerWinH() so dictated text lands in the focused terminal input. F4 was
// rejected by measurement: ink 6.x useInput surfaces function keys as
// (input='', key all-false) — indistinguishable from F1–F3. Alt+M arrives as
// key.meta + 'm' (probe: \x1bm), reliable in Windows Terminal.
let _voiceInput = null;
try {
  _voiceInput = require('../../../services/voiceInputService');
} catch {
  _voiceInput = null;
}
// Mouse-button layer (tui/mouseButtons.js): parses SGR mouse sequences, hit-tests
// the ink tree and dispatches to <Box onClick/onMouseUp/onMouseOver/…> — the mic
// voice button on the prompt is the first consumer (learned from opencode's
// opentui buttons). Fail-soft require; missing module → mouse seqs fall through
// to text editing (guarded by the same module's isMouseSequence in consumers).
let _mouse = null;
try {
  _mouse = require('../mouseButtons');
} catch {
  _mouse = null;
}
// Anchor-mode single source for mouse Y mapping (bottom vs top anchored).
let _startupAnchor = null;
try {
  _startupAnchor = require('../startupAnchor');
} catch {
  _startupAnchor = null;
}
// Transcript 视图的两个纯叶子(对齐 CC 的 `Transcript` context):scrollActions 是
// `scroll:*` 动作族的偏移算术,transcriptLines 把 messages 投影成可切片的文本行。
// fail-soft require:任一缺失 → _transcriptReady 为假 → Ctrl+O 逐字节回退为旧的
// 「就地展开上一步详情」,与 KHY_TRANSCRIPT_VIEW 关掉时同路径。
let _scrollActions = null;
try {
  _scrollActions = require('../scrollActions');
} catch {
  _scrollActions = null;
}
let _transcriptLines = null;
try {
  _transcriptLines = require('../transcriptLines');
} catch {
  _transcriptLines = null;
}
// 方向键归属判定叶子(CC context → bindings)。require 失败 → 块 4.7 的 switch 落到
// default,方向键一律转发给 textInput —— 退化但不瘫痪(子视图滚动会失效,输入不会丢)。
let _arrowRouting = null;
try {
  _arrowRouting = require('../arrowRouting');
} catch {
  _arrowRouting = null;
}
// Thin read-only Ink overlay for the reverse-search prompt line. Fail-soft; if the
// component is unavailable the search state simply renders nothing.
let _HistorySearchOverlay = null;
try {
  _HistorySearchOverlay = require('./HistorySearchOverlay');
} catch {
  _HistorySearchOverlay = null;
}
// Single-slot memo for the completion dropdown's caret margin (skips full-buffer
// re-layout while arrowing through the open menu). Fail-soft require; gate off /
// absent → compute every render (byte-identical). See promptCaretMarginMemo.
let _caretMarginMemo = null;
try {
  _caretMarginMemo = require('./promptCaretMarginMemo');
} catch {
  _caretMarginMemo = null;
}
// Background-notification port (fail-soft require): the CLI layer registers a
// renderer so services-level events (background task done/failed, turn
// complete) surface in the sidebar. Missing module → notifications never appear.
let _notificationPort = null;
try {
  _notificationPort = require('../../../services/notificationPort');
} catch {
  _notificationPort = null;
}
// Notification TTL single source: entries older than this disappear at render
// time (filtered against the existing nowTick heartbeat — zero new timers).
// KHY_NOTIFY_TTL_MS overrides the default, clamped to the floor.
const DEFAULT_NOTIFY_TTL_MS = 30000;
const NOTIFY_TTL_FLOOR_MS = 1000;
const NOTIFY_TTL_ENV = 'KHY_NOTIFY_TTL_MS';
function _notifyTtlMs(env) {
  const raw = parseInt(String((env || {})[NOTIFY_TTL_ENV] || ''), 10);
  if (Number.isFinite(raw)) {
    return Math.max(NOTIFY_TTL_FLOOR_MS, raw);
  }
  return DEFAULT_NOTIFY_TTL_MS;
}
// Transcript 视图门控(KHY_TRANSCRIPT_VIEW,default-on)。关掉或两个叶子任一 require
// 失败 → Ctrl+O 逐字节回退为旧的「就地展开上一步详情」,Transcript context 分支整段
// 不参与判定。FALSY 词表 = flagRegistry 的 CANON off-words(仅作 registry 不可用时的兜底)。
const _TRANSCRIPT_FALSY = new Set(['0', 'false', 'off', 'no']);
function _transcriptViewEnabled(env) {
  // flagRegistry 优先(集中真源),不可用再退本地 CANON 解析。绝不抛 —— 门控自身出错
  // 绝不能把 Ctrl+O 打没,所以最终兜底是 true(默认开)。
  try {
    return require('../../../services/flagRegistry').isFlagEnabled(
      'KHY_TRANSCRIPT_VIEW',
      env || process.env
    );
  } catch {
    /* fall through to local */
  }
  try {
    const raw = (env || process.env).KHY_TRANSCRIPT_VIEW;
    const v = String(raw === undefined || raw === null ? 'true' : raw)
      .trim()
      .toLowerCase();
    return !_TRANSCRIPT_FALSY.has(v);
  } catch {
    return true;
  }
}
// ── App.js 模块作用域助手（已抽取为叶子 ./appHostHelpers.js）────────────────────────
// 权限模式应用 + 任务面板行 + 状态行/spinner/队列面板派生,皆 React 闭包无关。完整实现见该
// 叶子(降上帝文件·DESIGN-ARCH-051 lineage,范式同 queryBridgeTimeline)。此处以 **同名
// re-import** 接回:App() 体、_renderQueuePanel 内部调用与 module.exports 均按原名消费,契约
// 字节不变。_caretMarginMemo(App() 专用,非本簇)保留于上方模块作用域。
const {
  _readMergedTaskLines,
  PERMISSION_MODES,
  applyPermissionMode,
  _normToolName,
  isQuestionRequest,
  _learnNeedsClassic,
  tuiUnsupportedReason,
  _taskActivity,
  _getStatusLabel,
  _liveActivity,
  _spinnerCcTokensEnabled,
  _estimateTok,
  _spinnerProgress,
  _queuePanelLines,
  _renderQueuePanel,
  _liveClampBoundaryDecision,
} = require('./appHostHelpers');
const caretGeometry = require('./caretGeometry');
const FooterBar = require('./FooterBar');
const FormFlow = require('./FormFlow');
const ModelPicker = require('./ModelPicker');
const PermissionsPrompt = require('./PermissionsPrompt');
const QuestionPrompt = require('./QuestionPrompt');
const RewindPicker = require('./RewindPicker');

/**
 * 「挂起 live UI → app.clear()」的沉降等待(ms)。必须 > ink 的 34ms 节流窗口,否则 clear()
 * 与迟到的 trailing 渲染竞态,导致输入框 chrome 残影。fail-soft:叶子不可用 → 历史 16ms。
 */
function _suspendSettleMs() {
  try {
    return require('../perfTunables').suspendSettleMs(process.env);
  } catch {
    return 16;
  }
}

// Pre-resolved modules for handleSubmit (eliminates per-submit require() calls).
// Module scope: loaded once at process init, cached for the session.
const _submitModules = (() => {
  const m = {};
  try {
    m.aliases = require('../../aliases');
  } catch {}
  try {
    m.nlModelSwitchResolver = require('../../nlModelSwitchResolver');
  } catch {}
  try {
    m.btwNote = require('../../../services/conversation/btwNote');
  } catch {}
  try {
    m.btwNoteQueue = require('../../../services/conversation/btwNoteQueue');
  } catch {}
  try {
    m.atMentionInject = require('../../atMentionInject');
  } catch {}
  try {
    m.inlineImageSubmit = require('../inlineImageSubmit');
  } catch {}
  try {
    m.imageRecognitionIntent = require('../../repl/imageRecognitionIntent');
  } catch {}
  try {
    m.planModeDirective = require('../../../services/planModeDirective');
  } catch {}
  return m;
})();

/**
 * 纯函数：计算 WelcomeBanner 的 props（含「更新」行），供启动横幅渲染。
 *
 * 从 App 体内抽出来是因为它只依赖 footer + package.json，不接触组件状态/终端，
 * 于是能在 node:test 里直接断言——App 的 banner 包在 <Static> 的 staticItems 里，
 * 需要一个完整的挂载环境才会渲染，测试没法走到那一步。
 *
 * 一切按 fail-soft 处理：模型名/窗口/更新行各自 try，后端不可用时字段为空字符串，
 * 横幅整行省略而不是显示占位值。绝不抛、绝不联网、绝不 spawn 包管理器。
 *
 * @param {object} [footer] 底部状态对象（{ model?, contextLimit?, adapter? }）
 * @param {object} [overrides] 测试注入用（{ pkg?, updateLine? }）
 * @returns {object} bannerProps
 */
function _resolveBannerProps(footer = {}, overrides = {}) {
  const props = {};
  try {
    // CC 后端口径对齐(与页脚统一):横幅同样走友好模型名 + ccFormatTokens 的窗口大小。
    // model 经 FooterBar.formatModelLabel(裸 slug → "Opus 4.8",未知 → 原样);
    // contextWindow 经 ccFormatTokens(1M 窗口 → "1m 令牌" 而非旧的 "1000k 令牌";
    // 200k → "200k 令牌" 逐字节不变)——消除 [[project_cc_token_count_semantics]] 记的最后一处
    // 散落本地 token 格式器(Math.round(limit/1000)+"k")。两者各自包 try,异常静默回退旧形。
    const pkg = overrides.pkg || require('../../../../package.json');
    let bannerModel = footer.model;
    try {
      if (FooterBar && FooterBar.formatModelLabel) {
        bannerModel = FooterBar.formatModelLabel(footer.model);
      }
    } catch {
      bannerModel = footer.model;
    }
    let bannerWindow = '';
    if (footer.contextLimit) {
      try {
        const fmt = require('../../ccFormat').ccFormatTokens;
        bannerWindow = typeof fmt === 'function' ? `${fmt(footer.contextLimit)} 令牌` : '';
      } catch {
        /* keep the legacy window string */
      }
    }
    bannerWindow = bannerWindow || (footer.contextLimit ? `${Math.round(footer.contextLimit / 1000)}k 令牌` : '');
    // 更新时间与来源：只读本地 git/BUILD-INFO，不联网、不 spawn 包管理器，
    // 因此可以同步取；失败时留空字符串，横幅整行省略而不是显示占位值。
    let bannerUpdateLine = '';
    try {
      if (overrides.updateLine) {
        bannerUpdateLine = overrides.updateLine;
      } else {
        const coordinator = require('../../../services/updateCoordinator');
        bannerUpdateLine = coordinator.formatProvenance(coordinator.getSourceProvenance());
      }
    } catch {
      /* 探测不可用时不展示更新行 */
    }
    props.version = pkg.version;
    props.model = bannerModel;
    props.adapter = footer.adapter || process.env.GATEWAY_PREFERRED_ADAPTER || 'auto';
    props.authMethod = 'API 密钥';
    props.contextWindow = bannerWindow;
    props.gatewayAdapters = 9;
    props.updateLine = bannerUpdateLine;
  } catch {
    /* bannerProps 组装失败不影响 App 主体 */
  }
  return props;
}

function App({ options = {} }) {
  const h = React.createElement;
  const { Box, Text, Static, useInput, useApp } = inkRuntime.get();
  const { exit } = useApp();

  // CC 对齐计划模式:真·循环拦到 ExitPlanMode(plan) 时,经 bridge 回调本 ref → 落 currentPlan、
  // 切 reviewing 态复用既有 PlanApproval。用 ref 打破「query 依赖 handler、handler 依赖 query」的
  // 循环依赖:先建空 ref、下方 effect 再装真正的句柄(handleLoopExitPlan)。门关时循环根本不回调。
  const planExitRef = React.useRef(null);
  const query = useQueryBridge({
    onExitPlanMode: (p) => {
      const fn = planExitRef.current;
      if (typeof fn === 'function') {
        fn(p);
      }
    },
  });
  const [footer, setFooter] = React.useState({});
  const _queryStatusRef = React.useRef(query.status);
  _queryStatusRef.current = query.status;

  // CC 对齐:页脚 `◎ /goal active (Nm)` 指示器状态。读活动持久目标 + 纯叶子 formatGoalElapsed
  // 算已持续时长标签。goalStore.getActiveGoal 走文件(非缓存),故不在每帧读——由下方一个低频
  // (30s)心跳 + 目标设定/清除后的显式刷新驱动(分钟级粒度足够)。异常/无目标 → null → 不渲。
  const [goalActive, setGoalActive] = React.useState(null);
  // Status mirror for the goal poll short-circuit below. Read through a ref so
  // refreshGoalActive keeps its [] dependency list — putting query.status in
  // the deps would tear down and rebuild the 30s interval on every status
  // change. Render-time ref assignment (same pattern as _sidebarVisibleRef).
  const _goalStatusRef = React.useRef(null);
  _goalStatusRef.current = query.status;
  // Lets the FIRST call (mount) through the short-circuit unconditionally so
  // the initial indicator state is always read.
  const _goalFirstReadRef = React.useRef(true);
  const refreshGoalActive = React.useCallback(() => {
    // Low-power short-circuit: the 30s poll skips the goalStore file IO when
    // the sidebar/rail is hidden AND no turn is active (idle/done/unset — the
    // same activity predicate as the busy heartbeat). The mount-time call
    // always proceeds (first-read latch) so the initial state stays correct.
    if (!_goalFirstReadRef.current) {
      const _st = _goalStatusRef.current;
      const _active = !!(_st && _st !== 'idle' && _st !== 'done');
      if (_sidebarVisibleRef.current === false && !_active) {
        return;
      }
    }
    _goalFirstReadRef.current = false;
    try {
      const goal = require('../../../services/goalStore').getActiveGoal(process.cwd());
      if (!goal || !goal.text) {
        setGoalActive((g) => (g == null ? g : null));
        return;
      }
      const label = require('../../../services/goalKickoff').formatGoalElapsed(
        goal.createdAt,
        Date.now()
      );
      setGoalActive((g) =>
        g && g.elapsedLabel === label && g.id === goal.id ? g : { id: goal.id, elapsedLabel: label }
      );
    } catch {
      setGoalActive((g) => (g == null ? g : null));
    }
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
  // PERFORMANCE: bridgeServer.getStatusSnapshot() is synchronous and includes
  // JSON.parse of config files. Moved from useState initializer (blocks first
  // paint) to a lazy ref populated on first mount effect tick (post-paint).
  const bridgeFooterOff =
    String(process.env.KHY_BRIDGE_FOOTER ?? '')
      .trim()
      .toLowerCase() === '0';
  const [bridgeStatus, setBridgeStatus] = React.useState(null);
  const _bridgeStatusRef = React.useRef(null);
  React.useEffect(() => {
    if (bridgeFooterOff) {
      return undefined;
    }
    let bridge;
    try {
      bridge = require('../../../bridge/bridgeServer');
    } catch {
      return undefined;
    }
    // Lazy populate: deferred to post-paint so it never blocks first frame.
    if (!_bridgeStatusRef.current) {
      try {
        _bridgeStatusRef.current = bridge.getStatusSnapshot();
      } catch {}
      setBridgeStatus(_bridgeStatusRef.current);
    }
    const refresh = () => {
      try {
        _bridgeStatusRef.current = bridge.getStatusSnapshot();
      } catch {}
      setBridgeStatus(_bridgeStatusRef.current);
    };
    refresh(); // reconcile against the live server once mounted
    let unsubscribe = null;
    try {
      unsubscribe = bridge.onBridgeEvent ? bridge.onBridgeEvent(refresh) : null;
    } catch {}
    return () => {
      try {
        if (unsubscribe) {
          unsubscribe();
        }
      } catch {
        /* ignore */
      }
    };
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
      if (!root) {
        return undefined;
      } // 非 khy monorepo → 不监视
      watcher.start({
        root,
        onAdvisory: (adv) => {
          if (!adv) {
            return;
          }
          // 人面:notice 追加(闲时可见)。
          try {
            if (adv.humanLine) {
              query.setMessages((m) => [
                ...m,
                { type: 'notice', content: adv.humanLine, timestamp: Date.now() },
              ]);
            }
          } catch {
            /* best-effort */
          }
          // AI 下一轮:btw 注记(提交时 mergeHints 排空)。
          try {
            if (adv.aiNote) {
              require('../../../services/conversation/btwNoteQueue').enqueue(adv.aiNote);
            }
          } catch {
            /* best-effort */
          }
        },
      });
    } catch {
      /* watcher is best-effort; never disturbs the session */
    }
    return () => {
      try {
        if (watcher) {
          watcher.stop();
        }
      } catch {
        /* ignore */
      }
    };
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
          effort: aiMod.getActiveEffort
            ? aiMod.getActiveEffort()
            : aiMod.getEffort
              ? aiMod.getEffort()
              : f.effort || 'medium',
          // Pass the active model so the REAL context window resolves; without the
          // hint getContextLimit() guesses and falls back to 128k.
          contextLimit: aiMod.getContextLimit
            ? aiMod.getContextLimit(activeModel)
            : f.contextLimit || UNKNOWN_MODEL_CONTEXT_WINDOW,
          contextPct: f.contextPct || 0,
        };
        // Equality guard: if every identity field is unchanged, return the SAME
        // ref so React skips the re-render (mirrors the contextPct guard at the
        // G-A effect). Without this, refreshFooter forced a render on every call.
        return footersEqual(f, next) ? f : next;
      });
    } catch {
      /* gateway/ai not ready yet — a later refresh will fill it in */
    }
  }, []);
  // Initial badge reflects the REAL booted permission mode (KHY_PERMISSION_MODE,
  // normalized by toolCalling) so the displayed mode never lies about the actual
  // tool-gating. Lazy + guarded: falls back to 'default' if toolCalling is
  // unavailable. getPermissionMode() returns the same vocabulary as
  // PERMISSION_MODES, so no extra normalization is needed here.
  const [permissionMode, setPermissionMode] = React.useState('default');
  const _permissionModeRef = React.useRef('default');
  // Lazy-resolve the real permission mode post-paint: toolCalling require +
  // getPermissionMode() involve filesystem IO and would block the synchronous
  // render path during initial mount.
  React.useEffect(() => {
    try {
      const tc = require('../../../services/toolCalling');
      const mode = tc.getPermissionMode ? tc.getPermissionMode() : 'default';
      _permissionModeRef.current = mode;
      setPermissionMode(mode);
    } catch {
      /* default is fine */
    }
  }, []);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [showHelp, setShowHelp] = React.useState(false);
  // Ctrl+R reverse-incremental history search (CC parity). null = inactive;
  // active = { query, matches, index, current } as returned by the pure leaf
  // historyReverseSearch. The overlay is a thin read-only renderer; all decision
  // logic lives in the leaf. Gated by KHY_HISTORY_REVERSE_SEARCH (default on).
  const [revSearch, setRevSearch] = React.useState(null);
  const [dismissedFor, setDismissedFor] = React.useState(null);
  const [expanded, setExpanded] = React.useState(false);
  // A committed <Static> row cannot re-render, so its Ctrl+O detail lives in the
  // removable live region. null = folded; an expansion view model = open.
  const [committedExpansion, setCommittedExpansion] = React.useState(null);
  // Any transcript mutation makes the temporary detail stale (new turn, clear,
  // resume, rewind). Clear it through one identity-based rule instead of wiring
  // every command path separately.
  React.useEffect(() => {
    setCommittedExpansion(null);
  }, [query.messages]);
  // Ctrl+T (CC app:toggleTodos) toggles the task checklist panel's visibility.
  // When hidden, the coordination block forces zero task lines so the live region
  // shrinks and StreamingBlock reclaims the rows.
  const [tasksHidden, setTasksHidden] = React.useState(false);
  // 网关探测状态折叠（默认折叠，按 Ctrl+G 展开/收起）。检测到不可用通道时
  // buildGatewayModelChoices 会推送多条 notice（检测进度、隐藏数量、
  // 各通道详情、首选通道不可用），折叠为单条摘要减少视觉噪音。
  const [gatewayCollapsed, setGatewayCollapsed] = React.useState(true);
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
  // Deferred gateway probe notice for /model. Pushing static (transcript) output
  // right before mounting the picker made ink write static lines AND grow the
  // live region in the same frame; past the terminal height this desyncs
  // log-update's previousLineCount (same scroll-desync family as the bug
  // documented in tui/topicBar.js), leaving a stale duplicated PromptFrame
  // behind. So the notice is stashed here and flushed when the picker closes.
  const pendingGatewayNoticeRef = React.useRef(null);
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
  // Images attached to the next turn (Ctrl+V from clipboard). Stable UI ids
  // allow deleting one item without disturbing the remaining image payloads.
  const [pendingImages, setPendingImages] = React.useState([]);
  const pendingImageIdRef = React.useRef(0);
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
  // Transcript 视图(对齐 CC 的 `app:toggleTranscript`):Ctrl+O 打开全量会话的可滚动
  // 视图,在里面能回到**任意**早前段落并展开它 —— 这是旧的「就地展开最后一条」做不到
  // 的事。`transcriptScroll` 是行偏移,`showAll` 对应 CC 的 `transcript:toggleShowAll`,
  // 复用全局 `expanded` state(它已同时驱动 <Static> 的 MessageBlock 与 StreamingBlock,
  // 所以视图里按 Ctrl+E 全展开,退出后 live/committed 两区也保持展开态)。
  const [transcriptOpen, setTranscriptOpen] = React.useState(false);
  const [transcriptScroll, setTranscriptScroll] = React.useState(0);
  // 门控 + 两个叶子都在 ⇔ Transcript 视图这条路可用。任一不满足 → Ctrl+O 与箭头
  // 路由整段回退到今天的行为(字节级回退,不留半开状态)。
  const _transcriptOn =
    _transcriptViewEnabled(process.env) && !!_transcriptLines && !!_scrollActions;
  // Spinner heartbeat: a 1s tick drives elapsed-time + stall detection while a
  // turn is in flight. lastActivityRef stamps the last time streamed output
  // changed, so a gap > 3s flags the turn as "等待响应…" (stalled).
  const [nowTick, setNowTick] = React.useState(0);
  const lastActivityRef = React.useRef(0);
  // Recent background notifications for the sidebar (notificationPort entries,
  // oldest first, capped at DEFAULT_NOTIFY_MAX). Expiry is filtered at render
  // time (nowTick heartbeat repaints) — zero new timers.
  const [notifications, setNotifications] = React.useState([]);
  // Render-scope sidebar-visibility mirror for the port callback (which fires
  // outside render) + dedupe set for the narrow-terminal inline degrade path.
  const _sidebarVisibleRef = React.useRef(false);
  const _notifyInlinedRef = React.useRef(new Set());
  // 设置项变更通知防抖(1.5s):连续切换设置时合并为一条 notice，避免每条
  // 切换都留下独立行污染 transcript。缓冲期内的后续变更会更新待发内容；
  // 静默期超过 1.5s 后推送最终摘要。
  const _settingNoticeTimer = React.useRef(null);
  const _settingNoticeBuffer = React.useRef([]);

  // Cleanup: clear the debounced setting-notice timer on unmount to avoid
  // dangling timers firing into an unmounted component.
  React.useEffect(() => {
    return () => {
      if (_settingNoticeTimer.current) {
        clearTimeout(_settingNoticeTimer.current);
      }
      _settingNoticeTimer.current = null;
      _settingNoticeBuffer.current = [];
    };
  }, []);

  // Session-max terminal dims (monotonic, 任务#18): the sidebar only renders
  // when the CURRENT size is within tolerance of the LARGEST size seen this
  // session — the closest terminal-side proxy for "window maximized", since
  // the OS maximize signal is unreadable from inside a terminal app. Updated
  // idempotently at render top; resize repaints ride the existing resizeNonce
  // debounce, so no extra listener is needed.
  // Seeded with the single-source fallback size (NOT {0,0}): a zero seed made
  // the first frame's fullscreen verdict disagree with every later frame, and
  // the 1s heartbeat re-render turned that disagreement into board flicker.
  const _maxDims = React.useRef({
    cols: sidebarLayout.fallbackCols(process.env),
    rows: sidebarLayout.fallbackRows(process.env),
  });

  // Zoom-immunity state (任务#24): the last EFFECTIVE terminal size and the
  // last sidebar verdict. Ctrl+wheel font zoom rescales cols/rows nearly
  // proportionally; classifyResize (pure leaf) detects that and the verdict
  // is kept sticky instead of being re-derived from the shifted grid.
  const _prevDims = React.useRef(null);
  const _lastSidebarVerdict = React.useRef(false);
  // Same sticky mechanism for the wide-terminal gate (inline task panel):
  // a font zoom shifts the column count and would otherwise flip _wideOn.
  const _lastWideVerdict = React.useRef(false);
  // Memoized size-derived layout decisions (sidebar width / stable rows /
  // fill rows / main cols): recomputed ONLY when the resolved size actually
  // changes, so the 1s heartbeat re-render can never thrash layout math.
  const _dimsDecision = React.useRef(null);
  // Sticky ROWS cache (根因 B): columns' sticky cache lives in effectiveCols
  // (shared with the deep components); rows have no deep readers, so App owns
  // this one. Same pure rule (sidebarLayout.stickyDim), same env gate.
  const _stickyRowsRef = React.useRef(null);

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

  // ── 语音听写(mic 按钮 / Alt+M 共用)───────────────────────────────────────
  // dictating 只反映「Win+H 听写面板是否开着」,与 /voice 的 voiceMode
  // (TTS/STT 会话模式)正交。静音自动停止 = **活动重置**空闲超时(AGENTS.md 规则 3):
  // 听写期间输入框每收到新内容(用户说话 → 系统落入文本)就重置计时,连续
  // VOICE_SILENCE_TIMEOUT_MS 无新内容 → 视为停止说话,自动再触发 Win+H 关闭面板。
  const [dictating, setDictating] = React.useState(false);
  const dictatingRef = React.useRef(false);
  const dictationTimerRef = React.useRef(null);
  const stopDictation = React.useCallback(
    (byUser) => {
      if (!dictatingRef.current) {
        return;
      }
      dictatingRef.current = false;
      setDictating(false);
      if (dictationTimerRef.current) {
        clearTimeout(dictationTimerRef.current);
        dictationTimerRef.current = null;
      }
      // 关闭面板:再发一次 Win+H(与开启同源,用户要求的「对接 win+h 键」)。
      if (_voiceInput && typeof _voiceInput.triggerWinH === 'function') {
        _voiceInput.triggerWinH().then((res) => {
          if (res && res.success) {
            showHint(byUser ? '🎤 已停止语音听写' : '🎤 检测到静音，已自动停止听写');
          } else if (byUser) {
            showHint('语音停止失败：' + ((res && res.error) || '未知错误'));
          }
        });
      }
    },
    [showHint]
  );
  const armSilenceTimer = React.useCallback(() => {
    if (!dictatingRef.current) {
      return;
    }
    if (dictationTimerRef.current) {
      clearTimeout(dictationTimerRef.current);
    }
    let ms = 6000;
    try {
      ms = require('../../../constants/serviceDefaults').VOICE_SILENCE_TIMEOUT_MS || 6000;
    } catch {
      /* default */
    }
    dictationTimerRef.current = setTimeout(() => stopDictation(false), ms);
  }, [stopDictation]);
  const toggleDictation = React.useCallback(() => {
    if (!_voiceInput || typeof _voiceInput.triggerWinH !== 'function') {
      showHint('语音输入不可用：voiceInputService 模块缺失');
      return;
    }
    if (dictatingRef.current) {
      stopDictation(true);
      return;
    }
    dictatingRef.current = true;
    setDictating(true);
    armSilenceTimer();
    _voiceInput.triggerWinH().then((res) => {
      if (res && res.success) {
        showHint('🎤 语音听写中：说话内容将进入输入框（再次点击麦克风或静音自动停止）');
        armSilenceTimer();
      } else {
        dictatingRef.current = false;
        setDictating(false);
        if (dictationTimerRef.current) {
          clearTimeout(dictationTimerRef.current);
          dictationTimerRef.current = null;
        }
        showHint('语音输入不可用：' + ((res && res.error) || '未知错误'));
      }
    });
  }, [showHint, stopDictation, armSilenceTimer]);
  // 听写文本经系统落入输入框时重置静音计时(活动重置);未在听写时不做事。
  const handleInputChange = React.useCallback(() => {
    if (dictatingRef.current) {
      armSilenceTimer();
    }
  }, [armSilenceTimer]);
  React.useEffect(
    () => () => {
      if (dictationTimerRef.current) {
        clearTimeout(dictationTimerRef.current);
      }
    },
    []
  );

  // 原生透传的两个 ref:是否正处于透传态 + 恢复追踪的定时器。这两个**曾经整个缺失**:
  // enterNativePassthrough 第一行 `mouseNativeRestoreTimer.current` 就 ReferenceError,
  // 而 dispatcher 的 fireNative() 把 onNative 包在 fail-soft 的 try/catch 里 —— 异常被
  // 静默吞掉,于是「关掉追踪、把这次滚轮/拖选交还终端」这一步一次都没有真正执行过。
  // 用户侧的表现就是彻底「滚不动、选不中」,而不是偶尔失灵:每一个滚轮事件都进了
  // stdin、被 dispatcher 吃掉,终端一个都没收到。
  const mouseNativeRef = React.useRef(false);
  const mouseNativeRestoreTimer = React.useRef(null);

  // Native passthrough. Tracking is exclusive: the wheel notch that got us here was
  // already delivered to stdin, so the terminal never saw it and there is no way to
  // hand it back — that first notch is simply lost. What we CAN do is get out of the
  // way for everything after it, by resetting tracking and staying out until the user
  // shows they want the buttons again.
  //
  // Only the wheel reaches here. Tracking is 1000 (X11 basic — see mouseButtons.js),
  // which reports press and release and nothing in between, so a drag never becomes
  // an event in this process at all and native selection works untouched. There used
  // to be a drag branch here compensating for 1002's motion reports; it could not
  // recover the swallowed press either way, and it went away with the downgrade.
  //
  // The window used to be 250ms, which made slow reading-speed scrolling (one notch
  // every few hundred ms) lose EVERY notch: each one re-armed tracking before the
  // next arrived. 1500ms covers a normal scroll-and-read cadence; each event
  // re-arms the timer, so a continuous scroll never re-enables mid-gesture.
  // exitNativePassthrough (below) is the other half: any keystroke means the user is
  // back at the prompt, so tracking returns immediately instead of waiting out the
  // idle window. KHY_MOUSE_NATIVE_MS overrides the window.
  const enterNativePassthrough = React.useCallback(() => {
    if (!_mouse || !process.stdout || !process.stdout.isTTY) {
      return;
    }
    if (mouseNativeRestoreTimer.current) {
      clearTimeout(mouseNativeRestoreTimer.current);
    }
    if (!mouseNativeRef.current) {
      mouseNativeRef.current = true;
      try {
        process.stdout.write(_mouse.disableBytes());
      } catch {
        /* fail-soft */
      }
    }
    let ms = 1500;
    try {
      const raw = Number(process.env.KHY_MOUSE_NATIVE_MS);
      if (Number.isFinite(raw) && raw > 0) {
        ms = raw;
      }
    } catch {
      /* default */
    }
    mouseNativeRestoreTimer.current = setTimeout(() => {
      mouseNativeRestoreTimer.current = null;
      mouseNativeRef.current = false;
      try {
        process.stdout.write(_mouse.enableBytes({ hover: _mouse.mouseHoverEnabled(process.env) }));
      } catch {
        /* fail-soft */
      }
    }, ms);
  }, []);
  // Keystroke = the user is typing at the prompt again, not reading scrollback →
  // reclaim tracking now rather than waiting out the idle window. No-op when we are
  // not currently in passthrough, so it is safe to call on every key.
  const exitNativePassthrough = React.useCallback(() => {
    if (!mouseNativeRef.current) {
      return;
    }
    if (mouseNativeRestoreTimer.current) {
      clearTimeout(mouseNativeRestoreTimer.current);
      mouseNativeRestoreTimer.current = null;
    }
    mouseNativeRef.current = false;
    if (!_mouse || !process.stdout || !process.stdout.isTTY) {
      return;
    }
    try {
      process.stdout.write(_mouse.enableBytes({ hover: _mouse.mouseHoverEnabled(process.env) }));
    } catch {
      /* fail-soft */
    }
  }, []);
  React.useEffect(
    () => () => {
      if (mouseNativeRestoreTimer.current) {
        clearTimeout(mouseNativeRestoreTimer.current);
      }
    },
    []
  );

  // Single mouse-dispatcher instance for the session (holds hover state).
  const mouseDispatcherRef = React.useRef(null);
  if (!mouseDispatcherRef.current && _mouse && typeof _mouse.createMouseDispatcher === 'function') {
    mouseDispatcherRef.current = _mouse.createMouseDispatcher({
      hover: _mouse.mouseHoverEnabled(process.env),
      onNative: enterNativePassthrough,
    });
  }

  // G-A: reflect the TRUE context-window fill in the footer. contextTokens is
  // the latest turn's reported usage (≈ current occupancy); contextLimit is the
  // resolved model window. Previously contextPct was pinned to 0 → a fake 0%.
  React.useEffect(() => {
    const limit = footer.contextLimit;
    const used = query.contextTokens || 0;
    if (!limit || limit <= 0) {
      return;
    }
    const pct = Math.min(100, Math.round((used / limit) * 100));
    setFooter((f) => (f.contextPct === pct ? f : { ...f, contextPct: pct }));
  }, [query.contextTokens, footer.contextLimit]);

  // G-B: 1s heartbeat while a turn is busy so the spinner can show elapsed time
  // and detect a stall. Stops when the turn settles (idle/done) to avoid an
  // always-on timer.
  React.useEffect(() => {
    const active = query.status && query.status !== 'idle' && query.status !== 'done';
    if (!active) {
      return undefined;
    }
    setNowTick(Date.now());
    // Cadence via the perfTunables leaf (default 2000ms, env KHY_HEARTBEAT_MS /
    // KHY_TUI_LOW_POWER override). Fail-soft: leaf unavailable → legacy 1000ms.
    let _hbMs = 1000;
    try {
      _hbMs = require('../perfTunables').heartbeatMs(process.env);
    } catch {
      _hbMs = 1000;
    }
    const id = setInterval(() => setNowTick(Date.now()), _hbMs);
    return () => clearInterval(id);
  }, [query.status]);

  // Notification port wiring: register the renderer once on mount, seed from
  // the buffered entries (emits that happened before mount), unregister on
  // unmount. Narrow-terminal degrade: warn/error entries print inline ONCE
  // (dedup by timestamp+title) when the sidebar is not visible; info stays
  // silent to avoid flooding the transcript.
  React.useEffect(() => {
    if (!_notificationPort) {
      return undefined;
    }
    const max = _notificationPort.DEFAULT_NOTIFY_MAX;
    const push = (entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      setNotifications((prev) => {
        // Mirror the port's adjacent same-type merge: a merged emit REPLACES
        // the previous entry instead of stacking a duplicate line.
        const last = prev[prev.length - 1];
        const merged = last && last.type === entry.type && Number(entry.count) > 1;
        const next = (merged ? prev.slice(0, -1) : prev).concat([entry]);
        return next.length > max ? next.slice(next.length - max) : next;
      });
      if (!_sidebarVisibleRef.current && (entry.level === 'warn' || entry.level === 'error')) {
        const key = `${entry.timestamp}|${entry.title}`;
        if (!_notifyInlinedRef.current.has(key)) {
          _notifyInlinedRef.current.add(key);
          try {
            const fmt = require('../../formatters');
            const text = entry.detail ? `${entry.title} · ${entry.detail}` : entry.title;
            if (entry.level === 'error') {
              fmt.printError(text);
            } else {
              fmt.printWarn(text);
            }
          } catch {
            /* aux output only — never throw */
          }
        }
      }
    };
    try {
      const seed = _notificationPort.getRecentNotifications();
      if (Array.isArray(seed) && seed.length > 0) {
        setNotifications(seed.slice(-max));
      }
      _notificationPort.registerNotificationRenderer(push);
    } catch {
      /* aux UI — never break mount */
    }
    return () => {
      try {
        _notificationPort.registerNotificationRenderer(null);
      } catch {
        /* ignore */
      }
    };
  }, []);

  // G-B: stamp the last time streamed output changed (throttled ~40ms upstream).
  // The stall check compares now − this stamp; a fresh turn resets it.
  React.useEffect(() => {
    lastActivityRef.current = Date.now();
  }, [query.streaming]);

  // `khy os` (no subcommand) launches straight into the kernel terminal: open
  // the KhyOsView overlay once on mount when the option is set.
  React.useEffect(() => {
    if (options.khyosDirect) {
      setKhyosOpen(true);
    }
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
        if (restored.length > 0) {
          query.setMessages(() => restored);
        }
      } catch {
        /* visual replay only — a failure must not affect loaded context */
      }
      // Interrupted-build continuation: auto-submit the original goal so the user
      // need not retype it (the bare-resume aiForward contract).
      if (options.resumeForward && typeof options.resumeForward === 'string') {
        try {
          query.submit(options.resumeForward, {});
        } catch {
          /* best effort */
        }
      }
    }
    // Sync the voice badge with the persisted voiceService flag on mount, so a
    // previously-enabled session shows the indicator without a re-toggle.
    try {
      const vs = require('../../../services/voiceService');
      if (vs.getVoiceSettings().enabled) {
        setVoiceMode(true);
      }
    } catch {
      /* voiceService unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+V image paste (Claude Code `chat:imagePaste`). Terminals deliver an
  // image on the system clipboard, not through stdin, so we read it explicitly
  // via the shared imageService (same cross-platform path the readline REPL
  // uses) and stage it as an attachment for the next turn. Nothing is sent yet.
  const attachClipboardImage = React.useCallback(() => {
    let imageService;
    try {
      imageService = require('../../../services/imageService');
    } catch {
      imageService = null;
    }
    if (!imageService || typeof imageService.readImageFromClipboard !== 'function') {
      showHint('图片粘贴不可用');
      return;
    }
    try {
      // Image-first, then clipboard file-path fallback (Claude Code model): a
      // bitmap is read directly; otherwise a copied/bridge-produced image path
      // is loaded. Falls back to the bitmap-only reader on older builds.
      const reader =
        typeof imageService.readImageFromClipboardOrPath === 'function'
          ? imageService.readImageFromClipboardOrPath
          : imageService.readImageFromClipboard;
      const img = reader();
      if (!img || !img.base64) {
        showHint('剪贴板没有图片（也不是图片路径）');
        return;
      }
      setPendingImages((list) => {
        const id = `pending-image-${++pendingImageIdRef.current}`;
        const next = pendingImageAttachments.appendAttachment(list, img, id);
        showHint(`已附加图${next.length}（Enter 发送，Esc 清除）`);
        return next;
      });
    } catch (err) {
      showHint('读取剪贴板图片失败：' + (err.message || err));
    }
  }, [showHint]);

  const removePendingImage = React.useCallback(
    (id) => {
      setPendingImages((list) => {
        const currentLabels = pendingImageAttachments.labels(list);
        const target = currentLabels.find((item) => item.id === id);
        const next = pendingImageAttachments.removeAttachment(list, id);
        if (next !== list && next.length !== list.length) {
          showHint(`${target ? target.label : '图片'}已删除，剩余 ${next.length} 张`);
        }
        return next;
      });
    },
    [showHint]
  );

  // ── Native model picker (/model) ───────────────────────────────────────
  // Probe adapters and open the ModelPicker overlay. Replaces the inquirer
  // prompt, which cannot coexist with ink's managed raw-mode input (the reason
  // `/model` exited immediately inside the TUI). Probe progress/diagnostics are
  // pushed into the transcript via the build callbacks.
  const openModelPicker = React.useCallback(async () => {
    const push = (role, content) =>
      query.setMessages((m) => [...m, { role, content, timestamp: Date.now() }]);
    let gw;
    try {
      gw = require('../../handlers/gateway');
    } catch {
      gw = null;
    }
    if (!gw || typeof gw.buildGatewayModelChoices !== 'function') {
      push('error', '模型选择不可用');
      return;
    }
    let built;
    try {
      // Buffer gateway status notices so they collapse into a single block
      // instead of flooding the transcript with 5-8 individual lines.
      const gwNotices = [];
      built = await gw.buildGatewayModelChoices({
        onNotice: (msg) => {
          gwNotices.push(msg);
        },
        onError: (msg) => push('error', msg),
      });
      if (gwNotices.length > 0) {
        const summary = gwNotices[0];
        const detail = gwNotices.join('\n');
        // Defer the transcript push until the picker closes: emitting static
        // output immediately before setModelPicker() is what triggered the
        // scroll desync / duplicated-PromptFrame artifact (see the ref's
        // comment). The empty/error paths below have no picker, so flush now.
        pendingGatewayNoticeRef.current = () =>
          push('notice', { content: summary, detail, gateway: true });
      }
    } catch (err) {
      // Mirror the empty branch: drain any deferred notice so it is neither
      // lost for this invocation nor leaked into the next /model open.
      const flushOnError = pendingGatewayNoticeRef.current;
      pendingGatewayNoticeRef.current = null;
      if (flushOnError) {
        flushOnError();
      }
      push('error', '探测模型失败：' + (err.message || err));
      return;
    }
    // Empty case already emitted its own explanatory notices in build().
    if (
      !built ||
      built.empty ||
      !Array.isArray(built.modelChoices) ||
      built.modelChoices.length === 0
    ) {
      const flushNow = pendingGatewayNoticeRef.current;
      pendingGatewayNoticeRef.current = null;
      if (flushNow) {
        flushNow();
      }
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
  const resolveModelPicker = React.useCallback(
    async (value) => {
      setModelPicker(null);
      // Flush the gateway probe notice deferred by openModelPicker now that the
      // picker is gone and the live region has shrunk back to a safe height.
      const flushDeferredNotice = pendingGatewayNoticeRef.current;
      pendingGatewayNoticeRef.current = null;
      if (flushDeferredNotice) {
        flushDeferredNotice();
      }
      if (!value) {
        query.setMessages((m) => [
          ...m,
          { role: 'notice', content: '已取消模型选择', timestamp: Date.now() },
        ]);
        return;
      }
      let gw;
      try {
        gw = require('../../handlers/gateway');
      } catch {
        gw = null;
      }
      if (!gw || typeof gw.applyGatewayModelSelection !== 'function') {
        query.setMessages((m) => [
          ...m,
          { role: 'error', content: '应用模型选择不可用', timestamp: Date.now() },
        ]);
        return;
      }
      try {
        const { tokenInfo } = await gw.applyGatewayModelSelection(value);
        query.setMessages((m) => [
          ...m,
          {
            role: 'notice',
            content: `已选择: ${value.model || '默认模型'} (${value.adapter}) · Token: ${tokenInfo.source} → ${tokenInfo.detail}`,
            timestamp: Date.now(),
          },
        ]);
        // Recompute from live sources so the new model's REAL context window and
        // effort are shown (not just the model/adapter labels).
        setFooter((f) => ({ ...f, model: value.model || 'auto', adapter: value.adapter }));
        refreshFooter();
      } catch (err) {
        query.setMessages((m) => [
          ...m,
          {
            role: 'error',
            content: '应用模型选择失败：' + (err.message || err),
            timestamp: Date.now(),
          },
        ]);
      }
    },
    [query, refreshFooter]
  );

  // Natural-language model switch ("切换模型到 deepseek"): reuse the SAME catalog
  // /model uses, filtered to one vendor. If the user named a model that uniquely
  // matches, apply it directly; otherwise open the picker over the vendor's models.
  // Driven by the pure leaf nlModelSwitchResolver (gated KHY_NL_MODEL_SWITCH); the
  // handleSubmit interceptor only calls this when resolve() returned a vendor hit.
  const openModelPickerForVendor = React.useCallback(
    async (vendor, modelHint) => {
      const push = (role, content) =>
        query.setMessages((m) => [...m, { role, content, timestamp: Date.now() }]);
      let gw;
      try {
        gw = require('../../handlers/gateway');
      } catch {
        gw = null;
      }
      if (!gw || typeof gw.buildVendorModelChoices !== 'function') {
        push('error', '模型切换不可用');
        return;
      }
      // Buffer vendor probe notices so they collapse into a single block, same as
      // openModelPicker. Pushing static output right before setModelPicker() is
      // what triggered the scroll desync / duplicated-PromptFrame artifact (see
      // pendingGatewayNoticeRef's comment), so the push is deferred whenever a
      // picker (or resolveModelPicker via directPick) will follow.
      const gwNotices = [];
      const flushNotices = () => {
        if (gwNotices.length === 0) {
          return;
        }
        push('notice', { content: gwNotices[0], detail: gwNotices.join('\n'), gateway: true });
      };
      let built;
      try {
        built = await gw.buildVendorModelChoices({
          vendor,
          modelHint,
          onNotice: (msg) => {
            gwNotices.push(msg);
          },
          onError: (msg) => push('error', msg),
        });
      } catch (err) {
        // No picker mounts on this path, so flushing immediately is safe.
        flushNotices();
        push('error', '探测模型失败：' + (err.message || err));
        return;
      }
      // Empty case already emitted its own explanatory notice in build(); no
      // picker mounts here either, so flush now (mirrors openModelPicker).
      if (
        !built ||
        built.empty ||
        !Array.isArray(built.modelChoices) ||
        built.modelChoices.length === 0
      ) {
        flushNotices();
        return;
      }
      // Defer the probe notice: resolveModelPicker drains pendingGatewayNoticeRef
      // after the picker unmounts, which also covers the directPick branch below
      // (it calls resolveModelPicker directly, so nothing is lost).
      if (gwNotices.length > 0) {
        pendingGatewayNoticeRef.current = flushNotices;
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
    },
    [query, resolveModelPicker]
  );

  // Open a FormFlow overlay and resolve with the collected answers (or null on
  // cancel). Returns a promise so command handlers can `await` the input the
  // same way they awaited inquirer, without inquirer fighting ink for stdin.
  const askForm = React.useCallback(
    (spec) =>
      new Promise((resolve) => {
        setFormFlow({ ...spec, resolve });
      }),
    []
  );

  const resolveFormFlow = React.useCallback((answers) => {
    setFormFlow((cur) => {
      if (cur && typeof cur.resolve === 'function') {
        cur.resolve(answers);
      }
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
    try {
      uiPrompt = require('../../uiPrompt');
    } catch {
      uiPrompt = null;
    }
    if (!uiPrompt) {
      return undefined;
    }
    uiPrompt.register(askForm);
    return () => uiPrompt.unregister();
  }, [askForm]);

  // Start the same post-first-frame background jobs as the classic REPL. Update
  // artifacts are downloaded and verified in the background; FormFlow asks for
  // the explicit install choice only after the active turn has settled.
  React.useEffect(() => {
    let timers = [];
    let active = true;
    const pushNotice = (content) => {
      if (!active || !content) return;
      query.setMessages((messages) => [
        ...messages,
        { type: 'notice', content: String(content), timestamp: Date.now() },
      ]);
    };
    const handleOutput = async (message) => {
      if (!active) return;
      if (!message || typeof message !== 'object' || !message.type) {
        pushNotice(message);
        return;
      }
      const state = message.state;
      if (message.type === 'update-blocked') {
        pushNotice(`KhyOS 更新已阻止: ${state?.blockedReason || state?.error || '当前源码状态不适合更新'}`);
        return;
      }
      if (message.type !== 'update-available') return;
      if (!state || state.state !== 'staged') {
        pushNotice(`更新预取失败: ${state?.error || '更新尚未完成校验'}`);
        return;
      }
      const target = state.target && (state.target.version || state.target.commit);
      const sourceType = state.source && state.source.type ? state.source.type : 'unknown';
      pushNotice(`发现 KhyOS 更新 (${sourceType}: ${target || '新版本'})`);
      const answer = await askForm({
        fields: [{
          name: 'choice',
          label: `接受 KhyOS 更新 ${target || ''}?`,
          type: 'select',
          choices: [
            { name: '现在安装', value: 'apply' },
            { name: '稍后', value: 'later' },
            { name: '跳过此版本', value: 'skip' },
          ],
        }],
      });
      if (!active) return;
      const coordinator = require('../../../services/updateCoordinator');
      if (answer && answer.choice === 'apply') {
        const result = await coordinator.applyUpdate({ state });
        pushNotice(
          result.state === 'applied'
            ? 'KhyOS 更新已接受，请重启以载入新版本。'
            : `更新失败，当前版本保持运行: ${result.error || '未知错误'}`
        );
      } else if (answer && answer.choice === 'skip') {
        coordinator.skipUpdate({ state });
        pushNotice('已跳过此版本。');
      } else {
        pushNotice('已暂存更新，稍后可运行 khy update 接受。');
      }
    };
    try {
      const { deferredPrefetch } = require('../../../bootstrap/prefetch');
      timers = deferredPrefetch({
        mode: options.mode === 'khy' ? 'khy' : 'khyquant',
        isBusy: () => {
          const status = _queryStatusRef.current;
          return status !== 'idle' && status !== 'done';
        },
        onOutput: handleOutput,
      });
    } catch {
      timers = [];
    }
    return () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [askForm, options.mode, query.setMessages]);

  // Drive the auth commands (login/register/passwd) through the native form
  // instead of the inquirer prompts baked into router.js's switch. The auth
  // service (cliAuthService) is the same one the readline REPL calls; only the
  // input-collection layer differs. Returns true if the command was consumed.
  const runAuthForm = React.useCallback(
    async (command) => {
      const push = (role, content) =>
        query.setMessages((m) => [...m, { role, content, timestamp: Date.now() }]);
      let cliAuth;
      try {
        cliAuth = require('../../../services/cliAuthService');
      } catch {
        cliAuth = null;
      }
      if (!cliAuth) {
        push('error', '账号服务不可用');
        return true;
      }

      if (command === 'login') {
        const session = cliAuth.checkSession();
        if (session.loggedIn) {
          push('notice', `当前已登录: ${session.username}（切换账号请先 /logout）`);
          return true;
        }
        // 自动登录：尝试用 default-admin 凭证静默登录（跳过输入）
        {
          let _defaultCreds = null;
          try {
            _defaultCreds =
              require('../../../services/credentialGenerator').readDefaultAdminCredentials();
          } catch {
            _defaultCreds = null;
          }
          if (_defaultCreds) {
            const autoResult = await cliAuth.login(_defaultCreds.username, _defaultCreds.password);
            if (autoResult && autoResult.success) {
              push('notice', `已自动登录: ${autoResult.username} (管理员)`);
              return true;
            }
          }
        }
        const answers = await askForm({
          title: '登录',
          fields: [
            {
              name: 'username',
              label: '用户名:',
              validate: (v) => v.trim().length > 0 || '请输入用户名',
            },
            {
              name: 'password',
              label: '密码:',
              type: 'password',
              validate: (v) => v.length > 0 || '请输入密码',
            },
          ],
        });
        if (!answers) {
          push('notice', '已取消登录');
          return true;
        }
        const result = await cliAuth.login(answers.username, answers.password);
        if (result.success) {
          push('notice', `登录成功! 欢迎, ${result.username}`);
        } else {
          push('error', result.error || '登录失败');
        }
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
            {
              name: 'username',
              label: '用户名 (至少 2 字符):',
              validate: (v) => v.trim().length >= 2 || '至少 2 个字符',
            },
            {
              name: 'password',
              label: '设置密码 (至少 6 字符):',
              type: 'password',
              validate: (v) => v.length >= 6 || '至少 6 个字符',
            },
            {
              name: 'confirm',
              label: '确认密码:',
              type: 'password',
              validate: (v, a) => v === a.password || '两次密码不一致',
            },
            { name: 'email', label: '邮箱 (可选):', validate: () => true },
          ],
        });
        if (!answers) {
          push('notice', '已取消注册');
          return true;
        }
        const result = await cliAuth.register(
          answers.username,
          answers.password,
          answers.email || undefined
        );
        if (result.success) {
          push('notice', `注册成功! 欢迎, ${result.username}`);
        } else {
          push('error', result.error || '注册失败');
        }
        return true;
      }

      if (command === 'passwd') {
        const answers = await askForm({
          title: '修改密码',
          fields: [
            {
              name: 'oldPassword',
              label: '当前密码:',
              type: 'password',
              validate: (v) => v.length > 0 || '请输入当前密码',
            },
            {
              name: 'newPassword',
              label: '新密码 (至少 6 字符):',
              type: 'password',
              validate: (v) => v.length >= 6 || '至少 6 个字符',
            },
            {
              name: 'confirm',
              label: '确认新密码:',
              type: 'password',
              validate: (v, a) => v === a.newPassword || '两次密码不一致',
            },
          ],
        });
        if (!answers) {
          push('notice', '已取消修改密码');
          return true;
        }
        const result = await cliAuth.changePassword(answers.oldPassword, answers.newPassword);
        if (result.success) {
          push('notice', '密码修改成功');
        } else {
          push('error', result.error || '修改失败');
        }
        return true;
      }

      return false;
    },
    [query, askForm]
  );

  // /apikey (gateway config) common paths — add a provider API key and configure
  // the network proxy — driven by native FormFlow overlays. The full settings
  // tree (ollama / relay / routing-policy / key-strategy / subscriptions / custom
  // providers …) stays in the classic inquirer flow; the entry menu routes there
  // with a notice when an advanced action is chosen.
  const runApiKeyConfig = React.useCallback(async () => {
    const push = (role, content) =>
      query.setMessages((m) => [...m, { role, content, timestamp: Date.now() }]);
    let gw;
    try {
      gw = require('../../handlers/gateway');
    } catch {
      gw = null;
    }
    if (!gw) {
      push('error', '网关服务不可用');
      return;
    }
    const onNotice = (c) => push('notice', c);
    const onError = (c) => push('error', c);

    const top = await askForm({
      title: 'API Key 配置',
      fields: [
        {
          name: 'action',
          label: '请选择:',
          type: 'select',
          choices: [
            { name: '添加 API Key（厂商密钥）', value: 'add-key' },
            { name: '配置网络代理（Clash / HTTP）', value: 'proxy' },
            { name: '其他高级配置（经典模式）', value: 'advanced' },
          ],
        },
      ],
    });
    if (!top) {
      push('notice', '已取消');
      return;
    }

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
      if (!pick) {
        push('notice', '已取消');
        return;
      }
      const provider = pick.provider;

      const fields = [
        {
          name: 'keyInput',
          label: `${provider.name} API Key:`,
          type: 'password',
          validate: (v) => v.trim().length > 0 || '请输入 API Key',
        },
      ];
      if (!provider.isToken) {
        fields.push({ name: 'label', label: '标签 (可选):', validate: () => true });
      }
      if (provider.models && provider.models.length > 0) {
        fields.push({
          name: 'model',
          label: '默认模型 (可选):',
          type: 'select',
          choices: [
            { name: '（不设置默认模型）', value: '' },
            ...provider.models.map((m) => ({ name: m, value: m })),
          ],
        });
      }
      const ans = await askForm({ title: `添加 ${provider.name}`, fields });
      if (!ans) {
        push('notice', '已取消');
        return;
      }

      await gw.applyProviderKey(
        {
          provider,
          keyInput: ans.keyInput,
          label: ans.label || '',
          model: ans.model || '',
        },
        { onNotice, onError }
      );
      return;
    }

    if (top.action === 'proxy') {
      const info = gw.getProxyConfigInfo();
      push('notice', info.active ? `当前代理: ${info.url || '(已启用)'}` : '当前未启用代理');
      if (info.warning) {
        push('notice', info.warning);
      }

      const ans = await askForm({
        title: '网络代理',
        fields: [
          {
            name: 'action',
            label: '操作:',
            type: 'select',
            choices: [
              { name: '自动检测并启用 Clash', value: 'detect' },
              { name: '手动设置 HTTP 代理端口', value: 'http' },
              { name: '关闭代理', value: 'off' },
            ],
          },
        ],
      });
      if (!ans) {
        push('notice', '已取消');
        return;
      }

      let port;
      if (ans.action === 'http') {
        const p = await askForm({
          title: 'HTTP 代理端口',
          fields: [
            {
              name: 'port',
              label: '端口:',
              defaultValue: '7890',
              validate: (v) => /^\d+$/.test(v.trim()) || '请输入端口数字',
            },
          ],
        });
        if (!p) {
          push('notice', '已取消');
          return;
        }
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
  const handleFlag = React.useCallback(
    (flag) => {
      const ai = () => require('../../ai');
      // 设置项变更通知防推:连续 1.5s 内的多条设置变更合并为一条摘要 notice，
      // 避免每条切换都留下独立行污染 transcript。
      const SETTING_NOTICE_DEBOUNCE_MS = 1500;
      const bufferedNotice = (content) => {
        _settingNoticeBuffer.current.push(content);
        if (_settingNoticeTimer.current) {
          clearTimeout(_settingNoticeTimer.current);
        }
        _settingNoticeTimer.current = setTimeout(() => {
          const buf = _settingNoticeBuffer.current;
          _settingNoticeBuffer.current = [];
          _settingNoticeTimer.current = null;
          if (buf.length === 0) {
            return;
          }
          if (buf.length === 1) {
            query.setMessages((m) => [
              ...m,
              { role: 'notice', content: buf[0], timestamp: Date.now() },
            ]);
          } else {
            const merged = buf.map((s, i) => `${i + 1}. ${s}`).join('\n');
            query.setMessages((m) => [
              ...m,
              { role: 'notice', content: merged, timestamp: Date.now() },
            ]);
          }
        }, SETTING_NOTICE_DEBOUNCE_MS);
      };

      switch (flag) {
        case 'thinking': {
          const next = !ai().isThinkingEnabled();
          ai().setThinkingEnabled(next);
          bufferedNotice(
            next
              ? '扩展思考已开启 — 模型产出推理（DeepSeek 切 R1），实时显示后折叠'
              : '扩展思考已关闭 — 跳过推理请求（DeepSeek 用 V3），省时延与 token'
          );
          return true;
        }
        case 'effort-max':
        case 'effort-high':
        case 'effort-medium':
        case 'effort-low': {
          const level = flag.slice('effort-'.length);
          ai().setEffort(level);
          refreshFooter(); // reflect the new effort in the status bar immediately
          bufferedNotice(`精度模式已切换为 ${level}`);
          return true;
        }
        case 'vim': {
          setVimEnabled((v) => {
            const next = !v;
            if (!next) {
              setVimMode('INSERT');
            }
            bufferedNotice(
              next
                ? 'Vim 模式已开启（INSERT 起步 · Esc 进 NORMAL · i/a/o 回 INSERT）'
                : 'Vim 模式已关闭'
            );
            return next;
          });
          return true;
        }
        case 'plan': {
          // Enter plan mode: read-only profile + flag the mode. The plan
          // generation/approval flow is driven on the next submit (stage 3).
          setPermissionMode('plan');
          applyPermissionMode('plan');
          bufferedNotice('已进入计划模式（只读）：输入需求以生成执行计划，Shift+Tab 可切回');
          return true;
        }
        case 'local': {
          setLocalMode((v) => {
            const next = !v;
            bufferedNotice(
              next
                ? '本地模式已开启 — 所有请求将使用本地能力处理（跳过 AI 模型）'
                : '本地模式已关闭 — 恢复 AI 模型调用'
            );
            return next;
          });
          return true;
        }
        case 'fast': {
          setFastMode((on) => {
            const next = !on;
            if (next) {
              // Capture current settings, then apply the quick-response preset.
              fastSavedRef.current = {
                thinking: ai().isThinkingEnabled(),
                effort: ai().getEffort(),
              };
              ai().setThinkingEnabled(false);
              ai().setEffort('low');
              bufferedNotice('快速模式已开启 — 已关闭扩展思考并切换到低精度（更快响应）');
            } else {
              const saved = fastSavedRef.current || { thinking: false, effort: 'medium' };
              ai().setThinkingEnabled(saved.thinking);
              ai().setEffort(saved.effort);
              fastSavedRef.current = null;
              bufferedNotice('快速模式已关闭 — 已恢复之前的思考与精度设置');
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
              bufferedNotice('语音模式已关闭');
            } else {
              const caps = voiceService.getCapabilities();
              voiceService.setVoiceEnabled(true);
              setVoiceMode(true);
              bufferedNotice(
                `语音模式已开启 — TTS: ${caps.tts || 'none'} | STT: ${caps.stt || 'none'}`
              );
            }
          } catch (err) {
            bufferedNotice(`语音服务异常：${err.message}`);
          }
          return true;
        }
        default:
          return false;
      }
    },
    [query, refreshFooter]
  );

  // Route a slash command through the shared router, yielding the terminal to
  // any interactive handler. The committed <Static> region stays mounted so
  // scrollback is not reprinted; only the transient live UI is suspended.
  const runRouted = React.useCallback(
    async (text) => {
      const { parseInput, route } = require('../../router');
      const parsed = parseInput(text.trim());
      if (!parsed) {
        return;
      }

      // /clear · /new · /reset 对齐 CC:清后端历史 + 复位网关熔断 + 清可见 transcript +
      // 清屏 + 归零上下文占用。三者语义相同(REPL repl.js 一并处理:/new「新建会话(清空当前
      // 上下文)」·/reset「重置会话(同 /new)」)。此前 TUI 只 /clear 有特判且只清了可见
      // transcript 与屏幕,后端模型上下文(ai._messages)与已跳闸的网关熔断都残留 → 用户眼中
      // 「完全失效」(AI 仍记得全部对话);而 /new·/reset 连特判都没有,直接被当普通文本转发给
      // AI(比 /clear 更糟:零动作)。全 best-effort try/catch,任何一步失败都不影响清屏/transcript。
      if (parsed.command === 'clear' || parsed.command === 'new' || parsed.command === 'reset') {
        try {
          require('../../ai').clearHistory();
        } catch {
          /* 清后端历史 best-effort */
        }
        try {
          require('../../sessionClear').resetGatewayBreakerOnSessionClear(process.env);
        } catch {
          /* 复位熔断 best-effort */
        }
        try {
          query.resetContext();
        } catch {
          /* 归零页脚上下文占用 best-effort */
        }
        query.setMessages([]);
        const app0 = inkRuntime.getApp();
        try {
          if (app0 && typeof app0.clear === 'function') {
            app0.clear();
          }
        } catch {
          /* ignore */
        }
        return;
      }

      // State-toggle flag commands (/thinking, /vim, /plan, /effort-*, …) are
      // handled in-process. route() returns false for most of them and would
      // otherwise forward the command to the AI as plain text.
      if (parsed.flag && handleFlag(parsed.flag)) {
        return;
      }

      // /rewind · /undo(无参)→ 打开原生 RewindPicker,与双 Esc 键流一致(共用
      // openRewindPicker → performRewind 管线)。此前无参 /rewind 落到 route()→handleRollback
      // 只在瞬态区打印一个纯文本回溯点列表(退化体验),而双 Esc 却给富交互原生选择器 —
      // 同一功能两套体验。带参形式(/rewind <n> 按序号直接回溯)仍走 route() 保留原语义。
      if (
        (parsed.command === 'rewind' || parsed.command === 'undo') &&
        (!parsed.args || parsed.args.length === 0) &&
        !parsed.subCommand
      ) {
        try {
          openRewindPicker();
        } catch {
          /* 打不开选择器则安全静默;不误发给 AI */
        }
        return;
      }

      // /model (and /gateway model) — drive the native ModelPicker instead of the
      // inquirer-backed handler, which cannot share ink's managed input. We do NOT
      // release the live region here; the picker renders inside it.
      if (
        parsed.command === 'gateway' &&
        (parsed.subCommand === 'model' || (parsed.args && parsed.args[0] === 'model'))
      ) {
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
      if (
        (parsed.command === 'topology' || parsed.command === 'forest') &&
        !parsed.subCommand &&
        !(parsed.args && parsed.args.length)
      ) {
        try {
          const forestSvc = require('../../../services/session/sessionForestService');
          const topoLeaf = require('../../sessionTopology');
          const { forest } = forestSvc.listForest({});
          const currentId = forestSvc.getCurrentSessionId();
          const degraded = !topoLeaf.topologyEnabled(process.env);
          setTopologyView({ forest, currentId, degraded });
          return;
        } catch {
          /* fall through to the text-tree handler */
        }
      }

      // Auth commands (/login /register /passwd) use the native FormFlow overlay
      // instead of router.js's inquirer prompts; the form renders in-place.
      if (
        parsed.command === 'login' ||
        parsed.command === 'register' ||
        parsed.command === 'passwd'
      ) {
        await runAuthForm(parsed.command);
        return;
      }

      // /apikey (gateway config) — native overlays for the common paths (add key /
      // proxy). Advanced sub-trees route to a classic-mode notice from inside.
      if (
        parsed.command === 'gateway' &&
        (parsed.subCommand === 'config' || (parsed.args && parsed.args[0] === 'config'))
      ) {
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
            query.setMessages((m) => [
              ...m,
              { role: 'notice', content: lines.join('\n'), timestamp: Date.now() },
            ]);
            return;
          }
          // /review — handleReview prints via console.log and collects its single
          // auto-fix confirm through the native uiPrompt/FormFlow bridge (because
          // KHY_INK_TUI_ACTIVE=1). Run it in a cleared transient region exactly like
          // the route() handlers below so the output is not clipped by the topic bar.
          const reviewApp = inkRuntime.getApp();
          setInputActive(false);
          try {
            topicBar.suspend();
          } catch {
            /* best effort */
          }
          // 右栏同理:交互子命令 clear() 后独占整屏,槽位里的看板必须先擦掉,
          // 否则原生 prompt 上会挂着一块过时的板子。finally 里 resume()。
          try {
            sidebarRail.suspend();
          } catch {
            /* best effort */
          }
          // 沉降等待必须 > ink 的 34ms 节流窗口,否则 clear() 与迟到的 trailing 渲染
          // 竞态 → 输入框 chrome 残影(与下方 route() 分支同一原因,同一真源)。
          await new Promise((r) => setTimeout(r, _suspendSettleMs()));
          try {
            if (reviewApp && typeof reviewApp.clear === 'function') {
              reviewApp.clear();
            }
          } catch {
            /* ignore */
          }
          try {
            const { handleReview } = require('../../handlers/review');
            await handleReview({});
          } catch (err) {
            query.setMessages((m) => [
              ...m,
              {
                role: 'error',
                content: `代码审查失败: ${err && err.message ? err.message : String(err)}`,
                timestamp: Date.now(),
              },
            ]);
          } finally {
            setInputActive(true);
            try {
              topicBar.resume();
            } catch {
              /* best effort */
            }
            try {
              sidebarRail.resume();
            } catch {
              /* best effort */
            }
          }
          return;
        }
      } catch {
        /* best-effort; fall through to existing dispatch */
      }

      // Native non-interactive commands (classic-REPL parity): /scan /hardware
      // /checkpoint /intent /study /mind do real local work in the classic REPL but
      // were silently forwarded to the AI here. Run them via the SAME services the
      // REPL calls (cli/tui/tuiCommandReports) and render the report into the
      // transcript. Gated KHY_TUI_NATIVE_COMMANDS (default on) → off falls through.
      try {
        const { dispatchNativeCommand } = require('../tuiCommandReports');
        const native = dispatchNativeCommand(parsed, {
          cwd: process.env.KHYQUANT_CWD || process.cwd(),
        });
        if (native.handled) {
          const content = (native.lines || []).join('\n') || '(无输出)';
          query.setMessages((m) => [...m, { role: 'notice', content, timestamp: Date.now() }]);
          return;
        }
      } catch {
        /* best-effort; fall through to existing dispatch */
      }

      // Remaining inquirer-driven handlers cannot yet share ink's managed input.
      // Intercept them with a clear notice instead of letting inquirer fight ink
      // for stdin and force the whole TUI to exit (the "/model quits KHY" class).
      const unsupported = tuiUnsupportedReason(parsed);
      if (unsupported) {
        query.setMessages((m) => [
          ...m,
          {
            role: 'notice',
            content: `「${unsupported}」暂需经典模式：请退出后用 KHY_FULL_TUI=0 khy 运行此命令。`,
            timestamp: Date.now(),
          },
        ]);
        return;
      }

      const app = inkRuntime.getApp();
      setInputActive(false);
      // Hand the interactive sub-command a clean full-screen scroll region: drop
      // the pinned topic bar (块3) so its reserved row 1 / DECSTBM does not clip
      // inquirer-style prompts. Restored in finally.
      try {
        topicBar.suspend();
      } catch {
        /* best effort */
      }
      // 右栏同理:交互子命令 clear() 后独占整屏,槽位里的看板必须先擦掉,
      // 否则原生 prompt 上会挂着一块过时的板子。finally 里 resume()。
      try {
        sidebarRail.suspend();
      } catch {
        /* best effort */
      }
      // Let React flush the suspended (empty live UI) frame before clearing, so
      // the handler starts from a clean transient region. 等待时长必须**超过 ink 自身的
      // 节流窗口**(maxFps 30 → 34ms,leading+trailing):历史硬编码的 16ms 短于该窗口,
      // 「空 live 区」那帧常仍挂在 trailing 队列 → clear() 擦除并 log.sync 了**旧**帧行数后,
      // 迟到的 trailing onRender 又把刚擦掉的输入框 chrome 画回来 =「输入框残影」。
      // 取值走 perfTunables 单一真源(KHY_TUI_SUSPEND_SETTLE_MS 可调);fail-soft 回退 16ms。
      await new Promise((r) => setTimeout(r, _suspendSettleMs()));
      try {
        if (app && typeof app.clear === 'function') {
          app.clear();
        }
      } catch {
        /* ignore */
      }

      let result;
      try {
        result = await route(parsed);
      } catch (err) {
        query.setMessages((m) => [
          ...m,
          { role: 'error', content: err.message, timestamp: Date.now() },
        ]);
      } finally {
        setInputActive(true);
        try {
          topicBar.resume();
        } catch {
          /* best effort */
        }
        try {
          sidebarRail.resume();
        } catch {
          /* best effort */
        }
      }

      if (result === 'exit') {
        exit();
        return;
      }
      // 命令跑完(可能是 /goal set/clear)→ 立即刷新页脚目标指示器,不等 30s 心跳。
      try {
        refreshGoalActive();
      } catch {
        /* footer indicator refresh is best-effort */
      }
      // /resume(= history resume)恢复了后端 ai._messages,但 route() 只返 true 无消息载荷 →
      // 复用启动 --resume 的同款机制(App.js:378-384)把已恢复的对话重放进可见 transcript,
      // 否则用户看到空屏而 AI 却"记得"全部对话(与旧 /clear 缺口同类的 UI↔后端不同步)。
      // bare-resume 返 {aiForward} 走下方分支自然回填,故仅在 result===true(完整恢复)时重放。
      if (
        result === true &&
        (parsed.command === 'resume' ||
          (parsed.command === 'history' && parsed.subCommand === 'resume'))
      ) {
        try {
          const restored = buildResumedTranscript(require('../../ai').getConversation());
          if (restored.length > 0) {
            query.setMessages(() => restored);
          }
        } catch {
          /* 可见重放 best-effort;模型上下文已在 ai._messages */
        }
      }
      // route() declined (unknown command / explicit AI forward) → send to AI.
      if (result === false || (result && result.aiForward)) {
        const aiInput = result && result.aiForward ? result.aiForward : text;
        query.submit(aiInput, { permissionMode, forceLocal: localMode });
      }
    },
    [
      query,
      exit,
      permissionMode,
      handleFlag,
      openModelPicker,
      runAuthForm,
      runApiKeyConfig,
      localMode,
      refreshGoalActive,
    ]
  );

  // Run a `!`-prefixed line as a shell command, reusing the shared shellCommand
  // tool (same execution path / Windows patching the AI uses). The command and
  // its output are committed to the transcript; nothing is sent to the model.
  const runBash = React.useCallback(
    async (text) => {
      const command = text.replace(/^!\s*/, '').trim();
      if (!command) {
        return;
      }
      query.setMessages((m) => [
        ...m,
        { role: 'bash-command', content: command, timestamp: Date.now() },
      ]);

      let tool;
      try {
        tool = require('../../../tools/shellCommand');
      } catch {
        tool = null;
      }
      if (!tool || typeof tool.execute !== 'function') {
        query.setMessages((m) => [
          ...m,
          { role: 'error', content: 'shell 工具不可用', timestamp: Date.now() },
        ]);
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
        query.setMessages((m) => [
          ...m,
          { role: 'bash-output', content: res.output || '', timestamp: Date.now() },
        ]);
      } else {
        // 红线：错误必须含真实原因 + 解决方向，绝不只是「命令执行失败」。
        let content;
        try {
          const { formatCliErrorLine } = require('../../cliErrorReporter');
          content = formatCliErrorLine(caught || res, {
            context: command,
            stderr: res && res.stderr,
          });
        } catch {
          content =
            (res && res.error) || '命令执行失败（未能解析具体原因，请以 KHY_VERBOSE=1 重跑）';
        }
        query.setMessages((m) => [...m, { role: 'error', content, timestamp: Date.now() }]);
      }
    },
    [query]
  );

  // Run a `#`-prefixed line as a quick instruction-file add (Claude Code `#`
  // behaviour): append it to khy.md's `## Memories` section via the SAME path as
  // the classic REPL (`#`) and `/remember` — instructionFileService.appendQuickMemory —
  // so the `#` entry has ONE consistent target across both front-ends. (Structured
  // personal memories go through SaveMemory / the proactive capture pipeline.)
  // The content is injection-scanned before write. Nothing is sent to the model.
  const runMemory = React.useCallback(
    async (text) => {
      const raw = text.replace(/^#+\s*/, '').trim();
      if (!raw) {
        return;
      }

      // `#g <note>` / `#global <note>` targets the user-global instruction file.
      let scope = 'project';
      let note = raw;
      const gm = raw.match(/^(g|global)\s+(.*)$/i);
      if (gm) {
        scope = 'global';
        note = gm[2].trim();
      }
      if (!note) {
        return;
      }

      let instr;
      try {
        instr = require('../../../services/instructionFileService');
      } catch {
        instr = null;
      }
      if (!instr || typeof instr.appendQuickMemory !== 'function') {
        query.setMessages((m) => [
          ...m,
          { role: 'error', content: '记忆设施不可用', timestamp: Date.now() },
        ]);
        return;
      }

      try {
        const res = instr.appendQuickMemory(note, { scope });
        if (res && res.success) {
          const where = scope === 'global' ? '全局' : '项目';
          query.setMessages((m) => [
            ...m,
            {
              role: 'notice',
              content: `已记入指令文件（${where}）：${res.file}${res.created ? ' (新建)' : ''}`,
              timestamp: Date.now(),
            },
          ]);
        } else {
          query.setMessages((m) => [
            ...m,
            {
              role: 'error',
              content: '写入记忆失败：' + ((res && res.error) || '未知错误'),
              timestamp: Date.now(),
            },
          ]);
        }
      } catch (err) {
        query.setMessages((m) => [
          ...m,
          { role: 'error', content: '写入记忆失败：' + err.message, timestamp: Date.now() },
        ]);
      }
    },
    [query]
  );

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
  const executePlan = React.useCallback(
    async (plan) => {
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
          panelState.setTasks(
            activeSteps.map((s) => ({ description: s.description, status: 'pending' }))
          );
          activeSteps.forEach((s, i) => idxByStepId.set(s.id, i));
        } catch {
          /* best effort — panel is auxiliary */
        }
      }

      try {
        const results = await planModeService.executePlanSteps(plan, {
          ai,
          renderer: makeStubRenderer(),
          onStepStart: ({ step, index, total }) => {
            if (planPanelOn) {
              try {
                panelState.updateTask(index, 'in_progress');
              } catch {
                /* ignore */
              }
            }
            notice(`▶ 第 ${step.id} 步（${index + 1}/${total}）：${step.description}`);
          },
          onStepResult: ({ step, result }) => {
            const ok = step.status === 'completed';
            if (planPanelOn) {
              try {
                const idx = idxByStepId.has(step.id) ? idxByStepId.get(step.id) : -1;
                if (idx >= 0) {
                  panelState.updateTask(idx, ok ? 'completed' : 'error');
                }
              } catch {
                /* ignore */
              }
            }
            notice(
              ok
                ? `✓ 第 ${step.id} 步完成`
                : `✗ 第 ${step.id} 步失败：${(result && result.error) || ''}`,
              ok ? 'notice' : 'error'
            );
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
          setTimeout(() => {
            try {
              panelState.clearTasks();
            } catch {
              /* ignore */
            }
          }, 1500);
        }
        setPlanPhase(null);
        setCurrentPlan(null);
        setPlanGenText('');
        try {
          planModeService.reset();
        } catch {
          /* ignore */
        }
        restorePermissionDefault();
      }
    },
    [query, restorePermissionDefault]
  );

  // Generate a plan from a plain request (driven on submit while in plan mode).
  const startPlan = React.useCallback(
    async (request) => {
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
        if (
          !res ||
          res.errorType ||
          !res.plan ||
          !Array.isArray(res.plan.steps) ||
          res.plan.steps.length === 0
        ) {
          setPlanPhase(null);
          setPlanGenText('');
          query.setMessages((m) => [
            ...m,
            {
              role: 'error',
              content:
                '计划生成失败：' +
                ((res && res.rawResponse) || '无有效计划，请重试或更具体地描述需求'),
              timestamp: Date.now(),
            },
          ]);
          return;
        }
        setCurrentPlan(res.plan);
        setPlanPhase('reviewing');
      } catch (err) {
        setPlanPhase(null);
        setPlanGenText('');
        query.setMessages((m) => [
          ...m,
          {
            role: 'error',
            content: '计划生成异常：' + (err.message || err),
            timestamp: Date.now(),
          },
        ]);
      }
    },
    [query]
  );

  // CC 对齐计划模式:真·循环里模型调 ExitPlanMode(plan) 后经 bridge 回调至此——把编号计划串
  // 解析成 steps 进 reviewing 复用既有 PlanApproval + 批准语法 + executePlan。解析不出步骤时
  // 兜底成单步(至少可批准执行),绝不因空计划把用户卡死。executePlanSteps 不依赖 planModeService
  // 的 reviewing 内部态(它自置 executing),故这里只驱动 UI 态即可,fail-soft 绝不崩 Ink。
  const handleLoopExitPlan = React.useCallback((p) => {
    try {
      const planModeService = require('../../../services/planModeService');
      const raw = p && typeof p.plan === 'string' ? p.plan : '';
      let plan = null;
      try {
        plan = planModeService.parsePlanFromResponse(raw);
      } catch {
        plan = null;
      }
      if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        const desc = (raw.trim() || '按上述调研结论执行').slice(0, 100);
        plan = {
          steps: [
            {
              id: 1,
              description: desc,
              status: 'pending',
              stepType: 'flexible',
              blocks: [],
              blockedBy: [],
            },
          ],
        };
      }
      setPlanGenText('');
      setCurrentPlan(plan);
      setPlanPhase('reviewing');
    } catch {
      /* fail-soft:计划评审装配绝不崩 UI */
    }
  }, []);
  React.useEffect(() => {
    planExitRef.current = handleLoopExitPlan;
  }, [handleLoopExitPlan]);

  // Parse a submitted line as a plan-approval command (mirrors the readline
  // presentForApproval grammar). Empty/y → approve+execute; n → cancel;
  // skip/edit/add → mutate the plan and keep reviewing; ? → show examples.
  const handlePlanCommand = React.useCallback(
    (text) => {
      const planModeService = require('../../../services/planModeService');
      const trimmed = String(text || '').trim();
      const lower = trimmed.toLowerCase();
      const notice = (content) =>
        query.setMessages((m) => [...m, { role: 'notice', content, timestamp: Date.now() }]);

      if (!trimmed || ['y', 'yes', 'ok', '确认', '执行', '继续'].includes(lower)) {
        if (currentPlan) {
          executePlan(currentPlan);
        }
        return;
      }
      if (['n', 'no', '取消', 'abort', 'stop'].includes(lower)) {
        try {
          planModeService.reset();
        } catch {
          /* ignore */
        }
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

      if (!currentPlan) {
        return;
      }
      const plan = { ...currentPlan, steps: currentPlan.steps.map((s) => ({ ...s })) };
      const commands = trimmed
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const applied = [];
      const invalid = [];
      for (const cmd of commands) {
        const skipMatch = cmd.match(/^(?:skip|跳过)\s+(\d+)$/i);
        const editMatch = cmd.match(/^(?:edit|修改)\s+(\d+)\s+(.+)$/i);
        const addMatch =
          cmd.match(/^(?:add|添加)\s+(?:after\s+)?(\d+)\s+(.+)$/i) ||
          cmd.match(/^在\s*(\d+)\s*后(?:添加)?\s+(.+)$/i);
        if (skipMatch) {
          const idx = parseInt(skipMatch[1], 10) - 1;
          if (idx >= 0 && idx < plan.steps.length) {
            plan.steps[idx].status = 'skipped';
            applied.push(`跳过 ${skipMatch[1]}`);
          } else {
            invalid.push(cmd);
          }
          continue;
        }
        if (editMatch) {
          const idx = parseInt(editMatch[1], 10) - 1;
          if (idx >= 0 && idx < plan.steps.length) {
            plan.steps[idx].description = editMatch[2].trim();
            applied.push(`修改 ${editMatch[1]}`);
          } else {
            invalid.push(cmd);
          }
          continue;
        }
        if (addMatch) {
          const afterIdx = parseInt(addMatch[1], 10);
          if (!Number.isNaN(afterIdx) && afterIdx >= 0 && afterIdx <= plan.steps.length) {
            plan.steps.splice(afterIdx, 0, {
              id: afterIdx + 1,
              description: addMatch[2].trim(),
              status: 'pending',
              blocks: [],
              blockedBy: [],
            });
            plan.steps.forEach((s, i) => {
              s.id = i + 1;
            });
            applied.push(`在 ${addMatch[1]} 后新增`);
          } else {
            invalid.push(cmd);
          }
          continue;
        }
        invalid.push(cmd);
      }
      setCurrentPlan(plan);
      if (applied.length) {
        notice('已更新计划：' + applied.join('、'));
      }
      if (invalid.length) {
        notice(
          '未识别：' +
            invalid.join(' ; ') +
            '（Enter 确认 / skip N / edit N 描述 / add after N 描述 / n）'
        );
      }
    },
    [currentPlan, executePlan, query, restorePermissionDefault]
  );

  const handleSubmit = React.useCallback(
    (text) => {
      // Plan-mode approval grammar consumes every submit while reviewing.
      if (planPhase === 'reviewing') {
        handlePlanCommand(text);
        return;
      }
      // Generation/execution are busy phases: ignore stray submits.
      if (planPhase === 'generating' || planPhase === 'executing') {
        return;
      }
      if (!text || !text.trim()) {
        // Allow an image-only turn: Enter with attachments but no text sends the
        // images with a default prompt.
        if (pendingImages.length > 0) {
          const imgs = pendingImageAttachments.toPayload(pendingImages);
          setPendingImages([]);
          query.submit('请描述这张图片', { permissionMode, images: imgs });
        }
        return;
      }
      const trimmed = text.trim();
      // `!`-prefixed input is the bash mode surface (Claude Code behaviour): run
      // the remainder as a shell command instead of routing or sending to the AI.
      if (trimmed.startsWith('!')) {
        runBash(trimmed);
        return;
      }
      // `#`-prefixed input is the memory mode surface: persist a memory note.
      if (trimmed.startsWith('#')) {
        runMemory(trimmed);
        return;
      }
      // Slash input is the command surface; everything else goes to the model.
      if (trimmed.startsWith('/')) {
        runRouted(text);
        return;
      }
      // Bare alias surface (classic-REPL parity): an explicit command shortcut as
      // the first token — e.g. `khyguanli`/`guanli`/`管理页` → gateway manage — is
      // dispatched through the router instead of being sent to the model. Only
      // ALIAS_MAP keys trigger this; plain prose still falls through to the AI
      // below, and runRouted forwards to the AI if route() ultimately declines.
      {
        const firstToken = trimmed.split(/\s+/)[0];
        let aliasHit = false;
        try {
          aliasHit = !!_submitModules.aliases?.resolveAlias(firstToken);
        } catch {
          /* ignore */
        }
        if (aliasHit) {
          runRouted(trimmed);
          return;
        }
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
        const nl = _submitModules.nlModelSwitchResolver;
        if (nl) {
          const hit = nl.resolve(trimmed, process.env);
          if (hit) {
            openModelPickerForVendor(hit.vendor, hit.model);
            return;
          }
        }
      } catch {
        /* best-effort; fall through to the model */
      }
      // Plan mode: a plain request generates an execution plan instead of a turn.
      if (permissionMode === 'plan') {
        // CC 对齐(KHY_PLAN_CC_RESEARCH):门开→计划提交走真·工具循环,先用只读工具调研、实时渲染
        // 工具调用(不弹「◴ 正在生成执行计划」大方框),模型调 ExitPlanMode(plan) 后经 onExitPlanMode
        // 进 reviewing。门关/异常→逐字节回退旧单次 startPlan(enterPlanMode)。submit 自身会入用户
        // 消息(bridge:1167),故此处不手动 setMessages。只读闸由 bridge 的 setTurnReadOnly 每轮把控。
        let _ccPlan = false;
        try {
          _ccPlan = _submitModules.planModeDirective?.isPlanResearchEnabled(process.env);
        } catch {
          _ccPlan = false;
        }
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
        const btw = _submitModules.btwNote;
        const btwQueue = _submitModules.btwNoteQueue;
        if (btw && btwQueue && btw.isEnabled(process.env) && btwQueue.count() > 0) {
          submitText = btw.mergeHints(submitText, btwQueue.drainAll());
        }
      } catch {
        /* best-effort; fall through to plain text */
      }
      // @path file/dir mention → content injection (classic-REPL parity, repl.js:4940-5001):
      // `@file` expands to a `[File: …]` content block, `@dir` to a `[Directory: …]` tree,
      // and sensitive files (.env/id_rsa/*.key) are blocked — via the SAME single source the
      // classic REPL now delegates to (cli/atMentionInject). Without this the TUI's `@` only
      // autocompletes a path and the model sees the literal `@path`. Never throws; surfaces
      // blocked/read notices into the transcript. Gated KHY_AT_MENTION_INJECT (default on).
      try {
        const { resolveAtMentions } = _submitModules.atMentionInject || {};
        if (resolveAtMentions) {
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
        }
      } catch {
        /* best-effort; fall through to plain text */
      }
      // Inline image path → attachment (classic-REPL parity, repl.js:5003-5022):
      // a typed/pasted local image path (file:///…png, C:\…\shot.png, /path/img.jpg)
      // is extracted into an image attachment via the SAME single source the REPL
      // and the web channel use, so the model gets the pixels instead of the path as
      // plain text. Reuses cli/repl/imageIntent + imageService; never throws (failure
      // → original text, no image). Gated KHY_TUI_INLINE_IMAGE_PATH (default on).
      let inlineImages = [];
      try {
        const r = _submitModules.inlineImageSubmit?.resolveInlineImageSubmit(submitText);
        if (r) {
          submitText = r.text;
          inlineImages = r.images || [];
        }
      } catch {
        /* best-effort; fall through to plain text */
      }
      // Normal AI turn — attach staged clipboard images + any inline-path image and
      // clear the buffer. The clipboard (pendingImages) and inline-path images merge
      // so a path typed alongside a pasted screenshot keeps both.
      const stagedImages = pendingImageAttachments.toPayload(pendingImages);
      const mergedImages = stagedImages.concat(inlineImages);
      if (mergedImages.length > 0) {
        if (stagedImages.length > 0) {
          setPendingImages([]);
        }
        query.submit(submitText, { permissionMode, images: mergedImages, forceLocal: localMode });
        return;
      }
      // Bare image-recognition intent with NO attached image (e.g. 裸「图片识别」): give it a
      // deterministic handling instead of falling into the agentic loop and globbing the disk.
      // clipboard-image → auto-use the clipboard image (Q1); no-image-reply → local notice, no
      // model call (Q2). Gated KHY_IMAGE_INTENT_GUARD (default on); off → byte fallback. Never throws.
      try {
        const { resolveImageRecognitionAssist } = _submitModules.imageRecognitionIntent || {};
        if (resolveImageRecognitionAssist) {
          const assist = resolveImageRecognitionAssist(submitText, { hasImages: false });
          if (assist && assist.handled) {
            if (assist.action === 'clipboard-image') {
              query.submit(assist.text, {
                permissionMode,
                images: assist.images,
                forceLocal: localMode,
              });
              return;
            }
            if (assist.action === 'no-image-reply') {
              query.setMessages((m) => [
                ...m,
                { role: 'notice', content: assist.reply, timestamp: Date.now() },
              ]);
              return;
            }
          }
        }
      } catch {
        /* best-effort; fall through to plain submit */
      }
      query.submit(submitText, { permissionMode, forceLocal: localMode });
    },
    [
      runBash,
      runMemory,
      runRouted,
      query,
      permissionMode,
      pendingImages,
      planPhase,
      handlePlanCommand,
      startPlan,
      localMode,
      openModelPickerForVendor,
    ]
  );

  const textInput = useVimInput({
    onSubmit: handleSubmit,
    enabled: vimEnabled,
    onModeChange: setVimMode,
    onChange: handleInputChange,
    mouseModule: _mouse,
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
  const performRewind = React.useCallback(
    (preselected, scope) => {
      const target = preselected || rewindControl.selectLastUserTarget(query.messages);
      if (!target) {
        showHint('无可回溯的对话');
        return;
      }
      if (typeof query.rewind !== 'function') {
        showHint('回溯不可用');
        return;
      }
      let res;
      try {
        res = query.rewind(target, scope);
      } catch {
        res = null;
      }
      if (!res || !res.success) {
        showHint('回溯失败');
        return;
      }
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
          query.setMessages((m) => [
            ...m,
            { role: 'notice', content: summaryNotice, timestamp: Date.now() },
          ]);
        } catch {
          /* fail-soft: fall back to the hint below */
        }
        _notice = summaryNotice;
      } else if (!conversationRewound) {
        // Code-only: conversation preserved.
        let stat = '';
        if (res.codeDiffStats) {
          stat = `（+${res.codeDiffStats.additions}/-${res.codeDiffStats.deletions} 行）`;
        }
        _notice = res.codeRestored ? `已恢复代码${stat},对话保留` : '代码检查点不可用,未改动';
      } else {
        try {
          _notice = require('../../rewindNotice').buildRewindNotice(
            { codeRestored: res.codeRestored, stats: res.codeDiffStats },
            process.env
          );
        } catch {
          _notice = res.codeRestored
            ? '已回溯对话与代码，可编辑后重发'
            : '已回溯对话（代码检查点不可用），可编辑后重发';
        }
      }
      showHint(_notice);
    },
    [query, textInput, showHint]
  );

  // Phase 2: open the RewindPicker so the user chooses *which* earlier user turn
  // to rewind to (not just the last). Builds the newest-first target list from
  // the single-source leaf; an empty history just hints. Selection routes back
  // through performRewind, so both phases share one rewind pipeline.
  const openRewindPicker = React.useCallback(() => {
    let targets = [];
    try {
      targets = rewindControl.listUserTargets(query.messages);
    } catch {
      targets = [];
    }
    if (!targets || targets.length === 0) {
      showHint('无可回溯的对话');
      return;
    }
    // One turn only → skip the overlay; Phase-1 semantics with no extra keystroke.
    if (targets.length === 1) {
      performRewind(targets[0]);
      return;
    }
    setRewindPicker({ targets });
  }, [query, showHint, performRewind]);

  const resolveRewindPicker = React.useCallback(
    (target, scope) => {
      setRewindPicker(null);
      if (target) {
        performRewind(target, scope);
      }
    },
    [performRewind]
  );

  // ── Native /rollback checkpoint picker (parity repl.js:3951-3975) ──────────
  // List recent checkpoints via the SAME checkpointService the classic REPL uses,
  // shape them into RewindPicker targets, and on selection restore the chosen
  // checkpoint. Empty history → honest notice (no overlay).
  const openRollbackPicker = React.useCallback(() => {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    let list = [];
    try {
      list = require('../../../services/workspace/checkpointService').listCheckpoints(cwd) || [];
    } catch {
      list = [];
    }
    if (!list.length) {
      query.setMessages((m) => [
        ...m,
        {
          role: 'notice',
          content: '没有可用的检查点。用 /checkpoint 手动保存，或等待 AI 对话自动保存。',
          timestamp: Date.now(),
        },
      ]);
      return;
    }
    const recent = list.slice(-10).reverse();
    const targets = recent.map((ck) => {
      let when = '';
      try {
        when = new Date(ck.timestamp).toLocaleString();
      } catch {
        when = '';
      }
      return {
        id: ck.id,
        checkpointId: ck.id,
        preview: `${ck.id}  ${ck.mode}  ${when}  ${String(ck.message || '').slice(0, 40)}`,
      };
    });
    setRollbackPicker({ targets, cwd });
  }, [query]);

  const resolveRollbackPicker = React.useCallback(
    (target) => {
      setRollbackPicker((cur) => {
        const cwd = (cur && cur.cwd) || process.env.KHYQUANT_CWD || process.cwd();
        if (target && target.id) {
          try {
            require('../../../services/workspace/checkpointService').restoreCheckpoint(
              cwd,
              target.id
            );
            query.setMessages((m) => [
              ...m,
              { role: 'notice', content: `已回滚到检查点: ${target.id}`, timestamp: Date.now() },
            ]);
          } catch (e) {
            query.setMessages((m) => [
              ...m,
              {
                role: 'error',
                content: `回滚失败: ${e && e.message ? e.message : String(e)}`,
                timestamp: Date.now(),
              },
            ]);
          }
        }
        return null;
      });
    },
    [query]
  );

  const completionRaw = useCompletions(value, offset);
  const completion =
    completionRaw.active && dismissedFor !== value ? completionRaw : { active: false, items: [] };

  // Reset menu selection whenever the candidate list changes.
  React.useEffect(() => {
    setSelectedIndex(0);
  }, [value, offset]);

  // Keep the footer truthful: refresh on mount, whenever the adapter reports new
  // status (model/window resolved asynchronously after gateway init), and once a
  // turn settles to idle/done (the active model + real context window are
  // guaranteed resolved by then). Cheap — it only reads getters.
  const _querySettled = query.status === 'idle' || query.status === 'done';
  React.useEffect(() => {
    refreshFooter();
  }, [refreshFooter, query.adapterInfo, _querySettled]);

  // The gateway warms its per-model context-window cache asynchronously right
  // after init, and no adapter/turn event fires when that cache fills. A pair of
  // one-shot delayed refreshes lets the footer pick up the real window at
  // startup instead of staying frozen at the 128k default until the first turn.
  React.useEffect(() => {
    const timers = [3000, 10000].map((ms) => setTimeout(() => refreshFooter(), ms));
    return () => {
      for (const t of timers) {
        clearTimeout(t);
      }
    };
  }, [refreshFooter]);

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
        try {
          require('../runtime/terminalCapabilities').invalidateCache();
        } catch {
          /* best effort */
        }
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
  // Review Major 2: no bare process.stdout.columns reads and no `||` falsy
  // chains here — `||` conflates 0 (garbage measurement, must be rejected)
  // with undefined (unknown, may fall back), re-creating the oscillation the
  // sticky cache exists to kill. Every resolution funnels through the SAME
  // _stickyCols single cache holder the render body uses. Explicit tri-state:
  // positive → use as-is; unknown (null) / garbage (0) → previous stable
  // value; nothing stable yet → the single-source fallback width.
  const _resolveResizeCols = (preferred, prev) => {
    const p = Number(preferred);
    if (Number.isFinite(p) && p > 0) {
      return Math.floor(p);
    }
    const s = _stickyCols(process.env);
    if (Number(s) > 0) {
      return Number(s);
    }
    const v = Number(prev);
    if (Number.isFinite(v) && v > 0) {
      return Math.floor(v);
    }
    return sidebarLayout.fallbackCols(process.env);
  };
  const _resizePrevCols = React.useRef(_resolveResizeCols(null, null));
  React.useEffect(() => {
    if (_resizeFirstCommit.current) {
      _resizeFirstCommit.current = false;
      _resizePrevCols.current = _resolveResizeCols(null, _resizePrevCols.current);
      return;
    }
    let inst = null;
    try {
      inst = inkRuntime.getInkInstance();
    } catch {
      inst = null;
    }
    const out = inst && inst.options && inst.options.stdout;
    const curCols = _resolveResizeCols(out ? out.columns : null, _resizePrevCols.current);
    const prevCols = _resizePrevCols.current;
    _resizePrevCols.current = curCols;
    if (!inst || typeof inst.onRender !== 'function') {
      return;
    }
    // Coalesce the repaint's writes into ONE stdout flush. ink's onRender emits
    // the frame as many separate process.stdout.write calls; on Windows each is a
    // blocking WriteConsole syscall, so a full-transcript shrink repaint becomes a
    // write storm that visibly freezes the terminal. syncWrite buffers every write
    // inside the frame and flushes a single chunk (and adds DEC-2026 markers where
    // supported). Best-effort: if syncOutput is unavailable, run the repaint bare.
    let _sync = null;
    try {
      _sync = require('../../syncOutput');
    } catch {
      _sync = null;
    }
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
          prevCols,
          curCols,
          rows,
          isTTY: !!(out && out.isTTY),
          fallbackRows: process.stdout.rows || sidebarLayout.fallbackRows(process.env),
          source: 'tui-resize',
        });
      } catch {
        _decision = null;
      }
      const _fullRepaint = _decision
        ? _decision.action === 'full-repaint'
        : (shrunk || grew) && out && out.isTTY && Number.isFinite(rows) && rows > 0;
      if (_fullRepaint) {
        // Zoom-in / shrink: force the fullscreen branch (hard clear + transcript
        // + live + log.sync). Heavy, but only on the direction that stacks.
        inst.lastOutputHeight = _decision ? _decision.rows : rows;
        if (typeof inst.calculateLayout === 'function') {
          inst.calculateLayout();
        }
        inst.onRender();
      } else {
        // Zoom-out / unchanged / non-TTY: light incremental resync, no redraw of
        // the transcript. Old lines still fit, so this erases exactly right.
        if (inst.log && typeof inst.log.clear === 'function') {
          inst.log.clear();
        }
        inst.lastOutput = '';
        inst.lastOutputToRender = '';
        if (typeof inst.calculateLayout === 'function') {
          inst.calculateLayout();
        }
        inst.onRender();
      }
    };
    try {
      if (_sync && typeof _sync.syncWrite === 'function') {
        _sync.syncWrite(_repaint);
      } else {
        _repaint();
      }
    } catch {
      /* best effort — ink's built-in repaint still applies */
    }
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
  // Gated on [query.streaming, extraReserve]: only samples during active streaming
  // AND when the reserve value might have changed. During idle the effect is a
  // no-op — no ink instance reads, no layout work. The streaming→idle transition
  // clears extraReserve to 0 (reset above), so the next streaming turn starts
  // cleanly.
  React.useLayoutEffect(() => {
    if (!_liveBudget || typeof _liveBudget.resolveExtraReserve !== 'function') {
      return;
    }
    const turnKey = query.streaming ? query.turnStartedAt || 0 : null;
    const _boundary = _liveClampBoundaryDecision(_extraTurnKey.current, turnKey, extraReserve);
    if (_boundary.changed) {
      _extraTurnKey.current = turnKey;
    }
    if (_boundary.reset) {
      setExtraReserve(0); // 新轮 / 轮结束且旧 reserve 非 0 → 先复位,下一帧再采样
      return;
    }
    if (!_boundary.sample || !query.streaming) {
      return;
    } // 仅生成中钳制; idle/复位态不采样
    let inst = null;
    try {
      inst = inkRuntime.getInkInstance();
    } catch {
      inst = null;
    }
    const out = inst && inst.options && inst.options.stdout;
    if (!out || !out.isTTY) {
      return;
    } // 非 TTY 永不 fullscreen
    let next = extraReserve;
    try {
      next = _liveBudget.resolveExtraReserve(
        {
          lastOutputHeight: Number(inst.lastOutputHeight),
          rows: Number(out.rows),
          prevExtra: extraReserve,
        },
        process.env
      );
    } catch {
      next = extraReserve;
    }
    if (next !== extraReserve) {
      setExtraReserve(next);
    } // 相等守卫防渲染循环
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
    try {
      on = topicBar.enable();
    } catch {
      on = false;
    }
    setTopicBarOn(on);
    return () => {
      try {
        topicBar.disable();
      } catch {
        /* terminal gone */
      }
    };
  }, []);

  // ── Right rail (任务看板带外画) ─────────────────────────────────────────────
  // Same shape as the topic bar above: a runtime module owns raw-ANSI painting
  // OUTSIDE the ink tree. enable() must receive the REAL process.stdout, never
  // app.jsx's Proxy — the rail's own writes (suspend / resize-clear / disable)
  // would otherwise get a rail suffix appended to them and recurse. Gate off /
  // non-TTY → enable() returns false and every other entry point is inert.
  //
  // enable() runs in the useState INITIALIZER, not in the effect, on purpose:
  // the value decides whether the welcome banner goes to <Static> and whether
  // SidebarPanel is in the tree at all, and <Static> consumes each item exactly
  // once — learning the answer one frame late would move the banner between
  // regions mid-startup. enable() is idempotent, so a double invocation (React
  // StrictMode) is harmless. The effect keeps only the teardown.
  const [railOn, setRailOn] = React.useState(() => {
    try {
      return sidebarRail.enable(process.stdout);
    } catch {
      return false;
    }
  });
  React.useEffect(() => {
    if (!railOn) {
      let on = false;
      try {
        on = sidebarRail.enable(process.stdout);
      } catch {
        on = false;
      }
      if (on) {
        setRailOn(true);
      }
    }
    return () => {
      try {
        sidebarRail.disable();
      } catch {
        /* terminal gone */
      }
    };
  }, []);
  // ── Right-rail keyboard nav (阶段四 交互能力增强, feature-flag 默认关) ──────
  // navOn is the master gate: BOTH the scroll and focus flags default OFF, so on
  // the legacy path navOn is false → useSidebarNav is inert (focused always false,
  // offset 0, no-op handlers) and the useInput guard below never enters any board
  // branch. The hook is called UNCONDITIONALLY (React rule); only its `enabled`
  // arg changes. Geometry (totalLines/visibleRows) comes from a ref refreshed at
  // the END of render, so the hook reads the PREVIOUS frame's values — off-by-one-
  // frame and harmless (the rail re-clamps the scroll offset on every paint).
  const navOn = sidebarLayout.focusEnabled(process.env) || sidebarLayout.scrollEnabled(process.env);
  const _navGeomRef = React.useRef({ totalLines: 0, visibleRows: 0 });
  const sidebarNav = useSidebarNav({
    totalLines: _navGeomRef.current.totalLines,
    visibleRows: _navGeomRef.current.visibleRows,
    enabled: navOn,
  });
  // Auto-close the shell peek panel when the turn ends (块4): its data source is
  // the live streaming state, which clears on finalize — keep the panel scoped
  // to EXECUTING so it never lingers showing an empty/stale tool.
  React.useEffect(() => {
    if (!busy && shellViewOpen) {
      setShellViewOpen(false);
      setShellScroll(0);
    }
  }, [busy, shellViewOpen]);

  // Push topic changes to the pinned bar (coarse instantly, AI-refined in place).
  React.useEffect(() => {
    if (!topicBarOn) {
      return;
    }
    try {
      topicBar.setTitle(topic);
    } catch {
      /* best effort */
    }
  }, [topic, topicBarOn]);
  // Animate the title glyph while khy is working: idle → static ✱ ("太阳"),
  // busy → left-right bouncing dot. Gated in the leaf (KHY_TOPIC_BAR_WORKING_DOT);
  // off → setWorking is a no-op and the glyph stays the static ✱.
  React.useEffect(() => {
    if (!topicBarOn) {
      return;
    }
    try {
      topicBar.setWorking(busy);
    } catch {
      /* best effort */
    }
  }, [busy, topicBarOn]);
  // Repaint the pinned bar after a settled resize, alongside the cache refresh.
  React.useEffect(() => {
    if (!topicBarOn) {
      return;
    }
    try {
      topicBar.onResize();
    } catch {
      /* best effort */
    }
  }, [resizeNonce, topicBarOn]);
  // Same for the rail: a SHRINK must wipe the geometry the last paint used, or
  // painted cells survive to the right of the new gutter. The next ink frame
  // (this very render) paints the new geometry via the stdout Proxy.
  React.useEffect(() => {
    if (!railOn) {
      return;
    }
    try {
      sidebarRail.onResize();
    } catch {
      /* best effort */
    }
  }, [resizeNonce, railOn]);

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

  useInput(
    (input, key) => {
      // 0) Mouse events own the top slot: dispatch clicks/hovers to <Box
      //    onClick/onMouseUp/…> buttons (e.g. the mic voice button) and consume
      //    the sequence so it can NEVER fall through to text editing as literal
      //    characters. Fail-soft: no root / bad tree → swallowed regardless.
      if (_mouse && mouseDispatcherRef.current && _mouse.isMouseSequence(input)) {
        try {
          const _inst = inkRuntime.getInkInstance();
          // 与 startupAnchor 完全同源的 rows 解析(stickyDim 三态 + fallback),避免
          // conpty 帧间 rows 瞬时 undefined 时映射错位(鼠标 SGR y 是物理终端行)。
          let _rows = null;
          try {
            _rows = sidebarLayout.stickyDim(process.stdout.rows, null, process.env);
          } catch {
            _rows = null;
          }
          if (typeof _rows !== 'number' || !Number.isFinite(_rows) || _rows <= 0) {
            _rows = sidebarLayout.fallbackRows(process.env);
          }
          const _anchorBottom = _startupAnchor
            ? _startupAnchor.anchorBottomEnabled(process.env)
            : false;
          mouseDispatcherRef.current.onInput(input, {
            rootNode: (_inst && _inst.rootNode) || null,
            rows: _rows,
            anchorBottom: _anchorBottom,
            // 布局缓存失效信号:每帧渲染后 lastOutput 变化 → 命中测试用新布局;
            // 渲染之间(移动事件风暴)复用同一份布局,避免整树 DFS 拖垮输入。
            cacheKey: (_inst && _inst.lastOutput) || '',
          });
          // KHY_TUI_DIAG=1 → stderr 打印每次鼠标事件的解析结果,便于真终端排查
          // 「图标可见但点不中」(坐标映射/命中测试)。
          if (String(process.env.KHY_TUI_DIAG || '').trim() === '1') {
            const _ev = _mouse.parseSgrMouse(input);
            const _root = (_inst && _inst.rootNode) || null;
            process.stderr.write(
              `[mouse] ${input} → col=${_ev && _ev.col} row=${_ev && _ev.row} ` +
                `rows=${_rows} anchorBottom=${_anchorBottom} root=${!!_root}\n`
            );
          }
        } catch {
          /* fail-soft */
        }
        return;
      }

      // 0a) Anything that is not a mouse sequence is a keystroke: the user is back
      //     at the prompt, so end any native passthrough now instead of waiting out
      //     the idle window. No-op unless we are actually in passthrough.
      exitNativePassthrough();

      // 0) Model picker overlay owns input while mounted (its own useInput drives
      //    navigation/selection); yield so there is no double-handling.
      if (modelPicker) {
        return;
      }
      // 0a2) Rewind picker overlay (Phase 2 double-ESC 回溯) owns input while mounted.
      if (rewindPicker) {
        return;
      }
      // 0a3) Rollback checkpoint picker (/rollback) likewise owns input while mounted.
      if (rollbackPicker) {
        return;
      }
      // 0b) FormFlow overlay (/login, /register, /passwd) likewise owns input.
      if (formFlow) {
        return;
      }
      // 0c) KHY OS kernel terminal overlay owns input (its own useInput sends
      //     keystrokes to the kernel serial port; Esc there closes the view).
      if (khyosOpen) {
        return;
      }
      // 0d) 会话拓扑只读面板(/topology view)挂载时:任意 Esc/Enter 关闭并归还输入。
      //     面板只读、不导航,故在此直接消费关闭键即可,其余键一律吞掉防穿透。
      if (topologyView) {
        if (key.escape || key.return) {
          setTopologyView(null);
        }
        return;
      }

      // 1) Permission prompt has top priority. Both QuestionPrompt and
      //    PermissionsPrompt own their own useInput (arrow-key navigation) and are
      //    mounted only while their request is pending, so we just yield here and
      //    let the overlay consume the key — no y/n/a handling in the parent.
      if (query.controlRequest) {
        return;
      }

      // 阶段四 (交互能力增强): board keyboard nav. GATED entirely on navOn — when
      // BOTH the scroll and focus flags are off (default) this whole block is
      // skipped and every existing key binding below runs byte-identically (zero
      // regression). When on: Alt+<focusKey> toggles board focus; while focused,
      // the arrows / Enter / Esc drive AND swallow navigation; when NOT focused the
      // arrows fall through to the existing handlers untouched (no return).
      // Guarded by !revSearch: reverse-incremental history search (Ctrl+R, the
      // branch below) owns ALL input while active, so an opt-in board-nav focus
      // must never swallow its ↑/↓/Enter/Esc — that would break the existing
      // Ctrl+R keyboard contract. navOn=false path stays byte-identical.
      if (navOn && !revSearch) {
        const _focusKey = sidebarLayout.focusKey(process.env);
        if (key.meta && !key.ctrl && input && input.toLowerCase() === _focusKey) {
          sidebarNav.onToggleFocus();
          return;
        }
        if (sidebarNav.focused) {
          if (key.upArrow) {
            sidebarNav.onUp();
            return;
          }
          if (key.downArrow) {
            sidebarNav.onDown();
            return;
          }
          if (key.return) {
            sidebarNav.onExpand();
            return;
          }
          if (key.escape) {
            sidebarNav.onEscape();
            return;
          }
        }
      }

      // Gateway status collapse toggle: Ctrl+G expands/collapses the latest
      // gateway status notice by mutating the message's _collapsed field (a new
      // object reference makes the <Static> child re-render). Guarded by
      // !revSearch: while reverse history search is active, Ctrl+G belongs to
      // the revSearch branch below (cancel search), so we must not steal it.
      if (key.ctrl && input === 'g' && !revSearch) {
        setGatewayCollapsed((c) => !c);
        const next = !gatewayCollapsed; // 切换后的目标状态
        query.setMessages((m) => {
          const msgs = [...m];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (
              msg.role === 'notice' &&
              msg.content &&
              typeof msg.content === 'object' &&
              msg.content.gateway === true
            ) {
              const updated = { ...msg, content: { ...msg.content, _collapsed: next } };
              msgs[i] = updated;
              break;
            }
          }
          return msgs;
        });
        return;
      }

      // When the prompt is empty, Backspace/Delete removes only the most recently
      // staged image. With text in the prompt these keys continue to edit text.
      if (pendingImages.length > 0 && value === '' && (key.backspace || key.delete)) {
        setPendingImages((list) => pendingImageAttachments.removeLastAttachment(list));
        showHint('已删除最后一张图片');
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
          try {
            setRevSearch(_revSearch.nextMatch(hist, revSearch));
          } catch {
            setRevSearch(null);
          }
          return;
        }
        // Enter / Tab → accept the current match into the input buffer, close.
        if (key.return || key.tab) {
          const chosen = revSearch.current || '';
          setRevSearch(null);
          if (chosen) {
            textInput.setText(chosen, chosen.length);
          }
          return;
        }
        // Arrow keys → CC behaviour: accept current into buffer, close, then let
        // the arrow move the cursor on the next tick (here we just accept + close).
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
          const chosen = revSearch.current || '';
          setRevSearch(null);
          if (chosen) {
            textInput.setText(chosen, chosen.length);
          }
          return;
        }
        // Backspace / Delete → trim one char off the query and re-search.
        if (key.backspace || key.delete) {
          const q = String(revSearch.query || '').slice(0, -1);
          try {
            setRevSearch(_revSearch.search(hist, q));
          } catch {
            setRevSearch(null);
          }
          return;
        }
        // Printable char (no ctrl/meta) → append to query and re-search.
        if (input && !key.ctrl && !key.meta) {
          const q = String(revSearch.query || '') + input;
          try {
            setRevSearch(_revSearch.search(hist, q));
          } catch {
            setRevSearch(null);
          }
          return;
        }
        // Any other key while active → swallow so it can't leak to the buffer.
        return;
      }

      // 1b) Transcript 视图(CC 的 `Transcript` context)打开时拥有全部输入。
      //     位置在 Ctrl+C / Ctrl+D 的全局处理**之前**:CC 在这个 context 里把
      //     ctrl+c 绑成 transcript:exit、ctrl+d 绑成 scroll:halfPageDown,若排在
      //     全局之后就永远被「双击退出」抢走。键位表逐条照抄 CC:
      //       ctrl+u/d 半页 · ctrl+b/f 整页 · ctrl+p/n & j/k & ↑↓ 单行
      //       g/home 顶 · G/end 底 · space 整页下 · b 整页上
      //       ctrl+e 展开/折叠工具输出 · esc/q/ctrl+c/ctrl+o 关闭
      //     偏移算术全部走 scrollActions 叶子(唯一真源,已 clamp),这里只做键→动作名。
      if (transcriptOpen) {
        if (key.escape || input === 'q' || (key.ctrl && (input === 'c' || input === 'o'))) {
          setTranscriptOpen(false);
          setTranscriptScroll(0);
          return;
        }
        // CC transcript:toggleShowAll —— 复用全局 expanded,所以退出视图后 live 区与
        // committed 区也保持同一展开态(这正是 CC 的语义)。
        if (key.ctrl && input === 'e') {
          setExpanded((v) => {
            const next = !v;
            showHint(next ? '会话记录：已展开工具输出' : '会话记录：已折叠工具输出');
            return next;
          });
          return;
        }
        let _act = null;
        if (key.ctrl && input === 'u') {
          _act = 'halfPageUp';
        } else if (key.ctrl && input === 'd') {
          _act = 'halfPageDown';
        } else if (key.ctrl && input === 'b') {
          _act = 'fullPageUp';
        } else if (key.ctrl && input === 'f') {
          _act = 'fullPageDown';
        } else if ((key.ctrl && input === 'p') || key.upArrow || (!key.ctrl && input === 'k')) {
          _act = 'lineUp';
        } else if ((key.ctrl && input === 'n') || key.downArrow || (!key.ctrl && input === 'j')) {
          _act = 'lineDown';
        } else if (key.pageUp) {
          _act = 'fullPageUp';
        } else if (key.pageDown) {
          _act = 'fullPageDown';
        } else if (key.home) {
          _act = 'top';
        } else if (key.end) {
          _act = 'bottom';
        } else if (input === 'g' || (input === 'G' && !key.ctrl)) {
          // 小写 g 跳顶、大写 G(shift+g)跳底 —— less/vim 惯例,与 CC 一致。
          _act = input === 'g' ? 'top' : 'bottom';
        } else if (!key.ctrl && input === ' ') {
          _act = 'fullPageDown';
        } else if (!key.ctrl && input === 'b') {
          _act = 'fullPageUp';
        }
        if (_act) {
          const _dims = _transcriptView || { lines: [], viewport: 0 };
          setTranscriptScroll((s) =>
            _scrollActions.applyScroll(_act, {
              offset: s,
              viewport: _dims.viewport,
              total: _dims.lines.length,
            })
          );
          return;
        }
        return; // 视图拥有输入:其余按键一律吞掉,绝不漏进输入缓冲区
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
        if (now - ctrlCAt.current < DOUBLE_PRESS_MS) {
          exit();
          return;
        }
        ctrlCAt.current = now;
        if (value) {
          textInput.clear();
        }
        showHint('再按一次 Ctrl-C 退出');
        return;
      }
      // Ctrl+D (CC chord): forward-delete when the line has text; on an empty
      // line, double-press exits.
      if (key.ctrl && input === 'd') {
        if (value) {
          textInput.onInput(input, key);
          return;
        }
        const now = Date.now();
        if (now - ctrlDAt.current < DOUBLE_PRESS_MS) {
          exit();
          return;
        }
        ctrlDAt.current = now;
        showHint('再按一次 Ctrl-D 退出');
        return;
      }
      // Ctrl+L: clear committed transcript.
      if (key.ctrl && input === 'l') {
        setCommittedExpansion(null);
        // 清空后 Transcript 视图会变成空壳,顺手关掉并归零偏移(与它的数据源同生命周期)。
        setTranscriptOpen(false);
        setTranscriptScroll(0);
        query.setMessages([]);
        return;
      }
      // Image paste (stage a clipboard image for the next turn). Windows binds
      // Alt+V because Ctrl+V is the terminal's own paste there (conhost / Windows
      // Terminal) and never reaches the app; other platforms keep Ctrl+V (their
      // terminal paste is Ctrl+Shift+V). In ink, Alt+V arrives as key.meta + 'v'.
      if (input === 'v' && (process.platform === 'win32' ? key.meta : key.ctrl)) {
        attachClipboardImage();
        return;
      }
      // Ctrl+O (CC app:toggleTranscript): open the scrollable full-conversation
      // view. 视图里能滚到**任意**早前段落并按 Ctrl+E 展开它 —— 这正是旧的「只能展开
      // 最后一条」做不到的事,也是不接管鼠标就能提供「点开某段」能力的那条路。
      if (key.ctrl && input === 'o') {
        if (_transcriptOn) {
          setTranscriptOpen((v) => {
            const next = !v;
            if (next) {
              setCommittedExpansion(null);
              setTranscriptScroll(0);
            }
            return next;
          });
          return;
        }
        // 门控关(或叶子 require 失败)→ 逐字节回退为旧的就地展开。
        // While a turn is live-streaming, the process group / thinking lives in the
        // dynamic StreamingBlock, which re-renders on prop change — toggle the
        // global flag so it expands/collapses in place.
        if (query.streaming) {
          setCommittedExpansion(null);
          setExpanded((v) => {
            const next = !v;
            showHint(next ? '过程组：已展开（显示完整详情）' : '过程组：已收起');
            return next;
          });
          return;
        }
        // The committed detail has landed in Ink's immutable <Static> region.
        // Toggle a force-expanded copy in the removable live layer: first press
        // opens it, second press lets Ink erase it in place.
        if (committedExpansion) {
          setCommittedExpansion(null);
          showHint('上一步详情：已收起');
          return;
        }
        const expansion = query.expandLastFoldable();
        if (expansion) {
          setCommittedExpansion(expansion);
          showHint('上一步详情：已展开（显示完整详情）');
        } else {
          showHint('暂无可展开的折叠内容');
        }
        return;
      }
      // Shift+Tab: cycle permission mode and push it to the real tool gate.
      if (key.tab && key.shift) {
        setPermissionMode((m) => {
          const next =
            PERMISSION_MODES[(PERMISSION_MODES.indexOf(m) + 1) % PERMISSION_MODES.length];
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
        try {
          _chord = _chatChords.resolveChatChord({ key, input }, process.env);
        } catch {
          _chord = null;
        }
        if (_chord === 'modelPicker') {
          if (busy) {
            showHint('忙碌中：请等当前轮次结束再切模型');
            return;
          }
          openModelPicker();
          return;
        }
        if (_chord === 'fastMode') {
          handleFlag('fast');
          return;
        }
        if (_chord === 'thinkingToggle') {
          handleFlag('thinking');
          return;
        }
        if (_chord === 'toggleTasks') {
          setTasksHidden((v) => {
            const next = !v;
            showHint(next ? '任务清单：已隐藏（Ctrl+T 再显示）' : '任务清单：已显示');
            return next;
          });
          return;
        }
      }

      // Alt+M: 语音输入 — 触发/关闭 Windows Win+H 语音听写(与麦克风按钮同源,
      // 同一个 toggleDictation:再按一次即停止,静音超时自动停止)。纯 meta 不带
      // ctrl,与 chatChords 的 Meta+P/O/T、图片粘贴 Alt+V 同族但键位互不重叠;
      // shift 不计较(部分终端 Alt 组合带 shift 位)。非 Windows 平台由
      // triggerWinH 自身的平台检查返回 error,提示后不再有副作用。与既有 /voice
      // 命令(TTS/STT 会话模式)正交:本键只唤起系统听写面板。
      if (key.meta && !key.ctrl && input.toLowerCase() === 'm') {
        toggleDictation();
        return;
      }

      // Ctrl+R: open reverse-incremental history search (CC parity). Only when
      // idle and the gate is on; otherwise fall through so the key is unchanged.
      // Initialises with an empty query (awaits typing, like bash reverse-i-search).
      if (key.ctrl && input === 'r' && _revSearch && _revSearch.isEnabled(process.env)) {
        const hist = (textInput.getHistory && textInput.getHistory()) || [];
        try {
          setRevSearch(_revSearch.search(hist, ''));
        } catch {
          setRevSearch(null);
        }
        return;
      }

      // 3) Completion menu navigation (when open).
      if (completion.active) {
        if (key.upArrow) {
          setSelectedIndex((i) => (i - 1 + completion.items.length) % completion.items.length);
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((i) => (i + 1) % completion.items.length);
          return;
        }
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
        if (key.escape) {
          setDismissedFor(value);
          return;
        }
        // any other key falls through to editing (and recomputes the menu)
      }

      // 4) Help overlay: "?" on an empty prompt toggles it.
      if (!completion.active && input === '?' && value === '') {
        setShowHelp((v) => !v);
        return;
      }
      if (showHelp && key.escape) {
        setShowHelp(false);
        return;
      }

      // 4.4) Esc while reviewing a plan cancels it (mirrors the `n` command).
      if (key.escape && planPhase === 'reviewing') {
        handlePlanCommand('n');
        return;
      }

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
          withinWindow: Date.now() - escAt.current < DOUBLE_PRESS_MS,
          rewindEnabled: rewindControl.isRewindEnabled(),
        });
        switch (verdict) {
          case 'vim':
            textInput.onInput(input, key);
            return;
          case 'drop-images':
            setPendingImages([]);
            showHint('已清除附加图片');
            return;
          case 'clear-input':
            textInput.clear();
            setHint('');
            return;
          case 'arm-clear':
            escAt.current = Date.now();
            showHint('再按一次 Esc 清空');
            return;
          case 'arm-rewind':
            escAt.current = Date.now();
            showHint('再按一次 Esc 回溯对话');
            return;
          case 'open-rewind':
            escAt.current = 0;
            openRewindPicker();
            return;
          default:
            return; // 'noop'
        }
      }

      // 4.7) Arrow navigation routed by interaction state (块4). Runs before the
      //      editing fallthrough. Vim owns its own motions, plan/help overlays
      //      keep their handling, so we only route plain arrows outside those.
      //
      //      判定全部下沉到 arrowRouting 叶子(照抄 CC 的 context → bindings 结构):这里
      //      只做「动作名 → 副作用」。历史上这段是一串有序 if,把优先级、条件与副作用缠在
      //      一起,读的人得从缩进反推谁压过谁;现在优先级只有叶子里那一个定义处,且可单测。
      const isArrow = key.upArrow || key.downArrow || key.leftArrow || key.rightArrow;
      if (isArrow && !vimEnabled && !planPhase && !showHelp) {
        const empty = value === '';
        const _arrowAct = _arrowRouting
          ? _arrowRouting.resolveArrowAction({
              key,
              shellViewOpen,
              busy,
              empty,
              queueLen: query.queueLen,
            })
          : null;
        switch (_arrowAct) {
          case 'subview:exit':
            setShellViewOpen(false);
            return;
          case 'scroll:lineUp':
            setShellScroll((s) => Math.max(0, s - 1));
            return;
          case 'scroll:lineDown':
            setShellScroll((s) => s + 1);
            return;
          case 'subview:openShell':
            setShellScroll(0);
            setShellViewOpen(true);
            return;
          case 'queue:editLast': {
            const item = query.dequeueLast();
            if (item) {
              textInput.setText(item.text);
              queueHintUsesRef.current += 1; // 学会一次「按 ↑ 编辑」→ 计入,达上限后占位符不再提示
              showHint('已取回排队消息，可编辑后重新发送');
            }
            return;
          }
          // history:previous / history:next / input:forward 都是「交给 useTextInput」:
          // 历史回溯本就由它实现(第一次 ↑ 暂存草稿、↓ 走过最新一条时还原),动作名分开
          // 是为了与 CC 注册表同构、让叶子的返回值自解释,副作用这里是同一个。
          case 'history:previous':
          case 'history:next':
          case 'input:forward':
            textInput.onInput(input, key);
            return;
          case 'noop':
            return; // 该 context 下此方向无绑定:吞掉,绝不漏进输入缓冲区
          default:
            break; // 叶子 require 失败(_arrowRouting 为 null)→ 落到下面的兜底转发
        }
        textInput.onInput(input, key);
        return;
      }

      // 5) Everything else → text editing.
      textInput.onInput(input, key);
    },
    { isActive: inputActive }
  );

  // Welcome banner props.
  const bannerProps = _resolveBannerProps(footer);

  // 输入框占位符:优先级阶梯收敛到纯叶子 promptPlaceholder(CC usePromptInputPlaceholder)。
  // 新增「有可编辑排队消息且提示未用尽 → 按 ↑ 编辑」一档;门控关/叶子缺失 → 逐字节回退历史两分支。
  let placeholder;
  try {
    const _pp = require('../promptPlaceholder');
    placeholder = _pp.resolvePromptPlaceholder(
      {
        reviewing: planPhase === 'reviewing',
        busy,
        queueEditable: !!(query && query.queueLen > 0),
        queueHintExhausted: queueHintUsesRef.current >= _pp.QUEUE_HINT_MAX_SHOWS,
        reviewText: 'Enter 确认执行 · skip/edit/add 修改 · n 取消',
        busyText: '',
        defaultText: '输入消息，/ 命令，@ 文件，! shell，# 记忆，? 快捷键，🎤 Alt+M 语音',
        queueHintText: '按 ↑ 编辑排队消息，或继续输入',
      },
      process.env
    );
  } catch {
    placeholder =
      planPhase === 'reviewing'
        ? 'Enter 确认执行 · skip/edit/add 修改 · n 取消'
        : busy
          ? ''
          : '输入消息，/ 命令，@ 文件，! shell，# 记忆，? 快捷键，🎤 Alt+M 语音';
  }

  // ── Live-region height coordination (anti scroll-jump) ──────────────────────
  // Read the merged task lines ONCE here (SSOT), cap them to a terminal-proportional
  // height, and compute StreamingBlock's reserve so it folds in the heights of the
  // sibling live panels below it. This keeps the whole live region < terminal rows,
  // so ink never enters its fullscreen clearTerminal repaint — which is what wipes
  // scrollback and yanks the view back to the top during long output. When the leaf
  // is unavailable / gate off, `_streamReserve` stays null and `_taskProps` empty →
  // StreamingBlock + TaskListPanel byte-revert to their legacy self-managed paths.
  // Wide-terminal sidebar decision (pure leaf sidebarLayout; fail-soft → off).
  // Resize repaints ride the existing resizeNonce debounce — no new listener.
  let _sidebarOn = false;
  let _sidebarWidthV = 30;
  // Relative STABLE height for the sidebar (task #20): constant vertical
  // footprint between transcript and prompt — never collapses with output.
  let _sidebarStableRowsV = 0;
  // Height CEILING for the post-first-message board (任务#8/#11): the board
  // shares the flex row with the left live column, top edge glued to the
  // message area's bottom edge; its height hugs the content and this value
  // caps it at rows - minChrome so it can never reach the prompt chrome.
  let _sidebarFillRowsV = 0;
  // Left (main) live-column width while the board shares the flex row (任务#12):
  // StreamingBlock budgets its visual-row tails against THIS width — full-width
  // budgeting undercounts soft-wrapped rows, overflows the viewport and
  // mis-erases frames (streamed text smeared across the board + board pushed
  // down). 0 = board off / leaf missing → legacy full-width path.
  let _mainColsV = 0;
  // Wide-terminal ("maximized") gate for wide-only UI such as the inline task
  // panel. Width-only by design: KHY_SIDEBAR=0 must not hide the inline panel.
  let _wideOn = false;
  // Sticky-RESOLVED dimensions hoisted for the rail decision + painter push
  // below (根因 A: one resolution, every consumer). Trichotomy per axis:
  // positive = usable, null = unknown (relaxed fallback gate), 0 = garbage.
  let _resCols = null;
  let _resRows = null;
  try {
    // P0 (Windows PowerShell board flicker/blank): resolve the terminal size
    // ONCE per render through the single-source fallback. conpty can report
    // undefined columns/rows; every consumer below must see the SAME resolved
    // pair, and the gates must know whether the size is real or assumed.
    // 根因 B (jitter/ghosting): the raw reads go through the STICKY resolvers
    // (effectiveCols.stickyCols for columns — shared cache with the deep
    // components — and sidebarLayout.stickyDim for rows), so a frame where
    // conpty momentarily reports undefined reuses the previous valid value
    // instead of collapsing to the assumed fallback and re-laying-out the tree.
    const _rawCols = _stickyCols(process.env);
    const _rawRows = sidebarLayout.stickyDim(
      process.stdout.rows,
      _stickyRowsRef.current,
      process.env
    );
    // D1: explicit type check (same rule as effectiveCols.stickyCols) — only a
    // finite positive NUMBER is a valid reading worth caching; null (unknown)
    // and 0 (garbage) must never overwrite the last valid rows.
    if (typeof _rawRows === 'number' && Number.isFinite(_rawRows) && _rawRows > 0) {
      _stickyRowsRef.current = _rawRows;
    }
    _resCols = _rawCols;
    _resRows = _rawRows;
    const _dimsKnown = Number(_rawCols) > 0 && Number(_rawRows) > 0;
    const _sbCols = _dimsKnown ? Number(_rawCols) : sidebarLayout.fallbackCols(process.env);
    const _sbRows = _dimsKnown ? Number(_rawRows) : sidebarLayout.fallbackRows(process.env);
    // null tells the pure leaves "size unknown → apply the relaxed fallback
    // gate (minColsFallback)" instead of the 120-col floor — otherwise the
    // assumed 80 columns would keep the board permanently hidden.
    const _gateCols = _dimsKnown ? _sbCols : null;
    const _gateRows = _dimsKnown ? _sbRows : null;
    // First frame: seed _prevDims with the ACTUAL resolved size so
    // classifyResize never compares against a missing previous size; the
    // verdict is still DERIVED below (forced 'resize'), not read from an
    // empty sticky, so the first frame follows the same path as later ones.
    const _firstDimsFrame = !_prevDims.current;
    if (_firstDimsFrame) {
      _prevDims.current = { cols: _sbCols, rows: _sbRows };
    }
    // Zoom-immunity (任务#24): classify this dimension change against the last
    // effective size (pure leaf classifyResize). First frame / leaf missing →
    // ordinary resize path.
    const _kind =
      _firstDimsFrame || typeof sidebarLayout.classifyResize !== 'function'
        ? 'resize'
        : sidebarLayout.classifyResize(
            _prevDims.current.cols,
            _prevDims.current.rows,
            _sbCols,
            _sbRows,
            process.env
          );
    if (_kind === 'zoom') {
      // Font zoom: keep the previous verdict (deliberately skipping the
      // minCols/minRows floors — zooming the font in must not hide the board)
      // and rescale the session max by the SAME ratios so future REAL window
      // resizes still compare against a correct "maximized" baseline.
      const _rc = _sbCols / _prevDims.current.cols;
      const _rr = _sbRows / _prevDims.current.rows;
      _maxDims.current.cols = Math.max(1, Math.round(_maxDims.current.cols * _rc));
      _maxDims.current.rows = Math.max(1, Math.round(_maxDims.current.rows * _rr));
      _sidebarOn = _lastSidebarVerdict.current;
      _wideOn = _lastWideVerdict.current;
    } else if (_kind === 'none') {
      // Unchanged dims (heartbeat re-render): reuse the sticky verdicts so a
      // post-zoom state is never re-evaluated against the raw floors.
      _sidebarOn = _lastSidebarVerdict.current;
      _wideOn = _lastWideVerdict.current;
    } else {
      // Real window resize (or first frame): monotonic session-max update.
      // D2: only MEASURED sizes may grow the session max — on unknown frames
      // _sbCols/_sbRows hold the ASSUMED fallback (80x24), and letting those
      // into the max would corrupt the fullscreen baseline whenever conpty
      // oscillates real ↔ undefined (intermittent board show/hide flicker).
      if (typeof sidebarLayout.nextSessionMax === 'function') {
        _maxDims.current = sidebarLayout.nextSessionMax(
          _dimsKnown,
          _sbCols,
          _sbRows,
          _maxDims.current.cols,
          _maxDims.current.rows
        );
      } else if (_dimsKnown) {
        if (_sbCols > _maxDims.current.cols) {
          _maxDims.current.cols = _sbCols;
        }
        if (_sbRows > _maxDims.current.rows) {
          _maxDims.current.rows = _sbRows;
        }
      }
      // Fullscreen-only gate: current size must sit within tolerance of the
      // session max on BOTH axes (sidebarLayout.isFullscreen semantics).
      _sidebarOn = sidebarLayout.shouldShowSidebar(
        _gateCols,
        _gateRows,
        _maxDims.current.cols,
        _maxDims.current.rows,
        process.env
      );
      _lastSidebarVerdict.current = _sidebarOn;
      // Wide-terminal gate re-derives ONLY on real resizes (zoom-immune, same
      // sticky pattern as the sidebar verdict above).
      _wideOn = sidebarLayout.isWideTerminal(_gateCols, process.env);
      _lastWideVerdict.current = _wideOn;
    }
    _prevDims.current = { cols: _sbCols, rows: _sbRows };
    // Memoized layout decisions (P1): recompute ONLY when the resolved size
    // actually changed — the 1s heartbeat re-render reuses the cache as-is,
    // so an unchanged size can never thrash the board's geometry. A font
    // zoom changes the resolved size, so the width still adapts naturally.
    if (
      !_dimsDecision.current ||
      _dimsDecision.current.cols !== _sbCols ||
      _dimsDecision.current.rows !== _sbRows
    ) {
      // Relative width: round(cols * ratio) clamped (pure leaf).
      const _w = sidebarLayout.sidebarWidth(_sbCols, process.env);
      // Stable height rides the same fail-soft try: leaf missing → 0 → hug.
      const _stable =
        typeof sidebarLayout.sidebarStableRows === 'function'
          ? sidebarLayout.sidebarStableRows(_sbRows, process.env)
          : 0;
      // Fill ceiling (任务#8/#11): leaf missing → fall back to the stable height.
      const _fill =
        typeof sidebarLayout.sidebarFillRows === 'function'
          ? sidebarLayout.sidebarFillRows(_sbRows, process.env)
          : _stable;
      // Left-column width (任务#12): cols - sidebarWidth via the pure leaf; leaf
      // missing → 0 → StreamingBlock keeps its legacy full-width budgeting.
      const _main =
        typeof sidebarLayout.mainColumnCols === 'function'
          ? sidebarLayout.mainColumnCols(_sbCols, process.env)
          : 0;
      _dimsDecision.current = {
        cols: _sbCols,
        rows: _sbRows,
        width: _w,
        stable: _stable,
        fill: _fill,
        main: _main,
      };
    }
    _sidebarWidthV = _dimsDecision.current.width;
    _sidebarStableRowsV = _dimsDecision.current.stable;
    _sidebarFillRowsV = _dimsDecision.current.fill;
    _mainColsV = _dimsDecision.current.main;
  } catch {
    _sidebarOn = false;
    _wideOn = false;
  }
  // ── 右栏收窄口径(与 effectiveCols 同一真源,渲染内只算一次) ─────────────────
  // `_railContentCols > 0` ⇔ SSOT 真的收窄了 ⇔ 最右侧那几列已经预留给带外画的看板。
  // 刻意不问 sidebarRail.isActive():那需要 enable() 先跑过,而深层组件(Transcript /
  // PromptFrame / ToolLines)只看得到无状态的 effectiveCols —— 两套判定一旦分歧就是
  // 「某处按全宽排版 → 软换行成没被高度账本数过的视觉行 → 楼梯/全屏重绘」。
  // `_railOut` 再叠一层 railOn(enable 成功=真有画笔):门控开但画笔起不来(非 TTY)时
  // 看板留在树里,只是画在收窄后的宽度里 —— 宁可略窄,不可凭空消失。
  const _railContentCols = (() => {
    // 根因 A/B: the decision input is the SAME sticky-resolved columns value
    // (_resCols) the dims block above used — not a fresh stdout read — so the
    // rail verdict, the in-tree board verdict and the painter's geometry all
    // derive from one resolution and cannot flip against each other on a
    // heartbeat frame where conpty momentarily reports undefined.
    const _rawC = _resCols;
    // Unknown size → compare against the SAME single-source assumed width the
    // rail painter uses (railGeometry substitutes fallbackCols), so painter
    // and ink tree can never disagree in the fallback state (double board /
    // blank gutter). Garbage (0/negative) still short-circuits to 0.
    const _real =
      Number(_rawC) > 0
        ? Number(_rawC)
        : _rawC == null
          ? sidebarLayout.fallbackCols(process.env)
          : 0;
    const _eff = _railCols(0);
    return _real > 0 && _eff > 0 && _eff < _real ? _eff : 0;
  })();
  const _railOut = _railContentCols > 0 && railOn;
  // ── Transcript 视图的行投影(只在视图打开时才算)────────────────────────────
  // 排版宽度用与 committed 区同一口径的 effectiveCols(_railCols),渲染器注入
  // Transcript 自己那个 renderMarkdown,保证视图里的排版与 <Static> 里一致。
  // 视口高度由 TranscriptView.bodyHeight 算,App 与组件共用同一个函数 —— 所以
  // Ctrl+D 翻的「半页」正是屏幕上看到的那半页。
  const _transcriptView = React.useMemo(() => {
    if (!transcriptOpen || !_transcriptLines) {
      return null;
    }
    const cols = _railCols(0) || Number(_resCols) || 0;
    const lines = _transcriptLines.buildTranscriptLines(query.messages, {
      cols,
      showAll: expanded,
      renderMarkdown: Transcript.renderMarkdown,
      summarizeTool: ToolLines.summarizeArgs,
    });
    return { lines, viewport: TranscriptView.bodyHeight(_resRows, lines.length) };
  }, [transcriptOpen, expanded, query.messages, _resCols, _resRows]);
  // Task #23: at startup (no committed messages yet) the welcome banner
  // renders inside the live row's LEFT column, so its version line and the
  // sidebar's top edge share the SAME terminal row (left/right split — the
  // flex row keeps the columns apart, no character collision). The decision
  // is made ONCE on the first render and stays sticky until the first
  // message arrives: <Static> consumes items exactly once, so flipping later
  // would either duplicate the banner in scrollback or lose it entirely.
  // First message → staticItems.length > 1 → the banner (item 0) is handed
  // back to <Static> and committed to scrollback in its normal position.
  const _bannerInLiveRef = React.useRef(null);
  if (_bannerInLiveRef.current === null) {
    _bannerInLiveRef.current = _sidebarOn;
  }
  // 右栏模式下右列根本不存在(SidebarPanel 已出 ink 树),没有「与看板顶边共享同一行」
  // 可言 → 横幅回到 <Static> 走正常提交。仍然只在首帧决定一次,粘滞语义不破。
  if (_railOut) {
    _bannerInLiveRef.current = false;
  }
  const _bannerInLive = _bannerInLiveRef.current === true && query.staticItems.length === 1;
  // Lucky-clover art gate: the banner's right-column art renders only when the
  // banner's OWN column is wide enough. Width inputs reuse THIS frame's
  // sticky-resolved values (_resCols / _mainColsV / _railContentCols) — the
  // banner never self-reads process.stdout (effectiveCols leaf contract).
  const _bannerShowArt = (() => {
    const MIN_ART_COLS = 80;
    // Live-row banner shares the flex row with the board → left-column width.
    if (_bannerInLive && (_sidebarOn || _railOut) && Number(_mainColsV) > 0) {
      return Number(_mainColsV) >= MIN_ART_COLS;
    }
    // Rail mode narrows the whole ink tree; otherwise use resolved terminal cols.
    if (_railOut) {
      return _railContentCols >= MIN_ART_COLS;
    }
    if (Number(_resCols) > 0) {
      return Number(_resCols) >= MIN_ART_COLS;
    }
    // Unknown size → the SAME conservative single-source fallback the rail uses.
    if (_resCols == null) {
      try {
        return sidebarLayout.fallbackCols(process.env) >= MIN_ART_COLS;
      } catch {
        return false;
      }
    }
    return false;
  })();
  // Rows the banner renders above its version line — SSOT exported by
  // WelcomeBanner (bannerRowsBeforeVersion) so the sidebar's top edge lands
  // on the SAME terminal row as `── khy OS vX.X.X ──` without magic numbers.
  let _bannerVersionOffset = 0;
  try {
    _bannerVersionOffset =
      typeof WelcomeBanner.bannerRowsBeforeVersion === 'function'
        ? Math.max(0, Math.floor(Number(WelcomeBanner.bannerRowsBeforeVersion()) || 0))
        : 0;
  } catch {
    _bannerVersionOffset = 0;
  }
  // The full-width inline TaskListPanel is the sole task renderer. It remains
  // independent of sidebar/wide-terminal gates and is height-capped through the
  // same liveRegionBudget ledger used by StreamingBlock.
  let _streamReserve = null;
  let _taskProps = {};
  if (_liveBudget) {
    // Same sticky-resolved rows as the dims block above (根因 B): a phantom
    // undefined-rows frame must not shrink/regrow the task-line budget.
    const _termRows =
      Number(_resRows) > 0 ? Number(_resRows) : sidebarLayout.fallbackRows(process.env);
    // Ctrl+T hides the checklist. The inline panel is available at every width;
    // sidebar visibility never suppresses the canonical task data read.
    const _mergedTaskLines = tasksHidden ? [] : _readMergedTaskLines();
    const _rawTaskLines = tasksHidden ? [] : _mergedTaskLines;
    if (process.env.KHY_DEBUG_TASK_PANEL === '1') {
      try {
        process.stderr.write(
          `[task-debug] rawLines=${_rawTaskLines.length} sidebarOn=${_sidebarOn} tasksHidden=${tasksHidden}\n`
        );
      } catch {
        /* non-critical */
      }
    }
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
    } catch {
      _splitLabelRows = 0;
    }
    _streamReserve = _liveBudget.resolveStreamReserve(
      {
        rows: _termRows,
        toolCount: (query.streaming && query.streaming.tools && query.streaming.tools.length) || 0,
        taskLineCount: _capped.lines.length + _splitLabelRows,
        taskHasHiddenNotice: _capped.hidden > 0,
        planActive:
          planPhase === 'generating' || planPhase === 'reviewing' || planPhase === 'executing',
        queueLen: query.queueLen || 0,
        steerLen: query.steerLen || 0,
        // 页脚变高的两条条件行(BASE_CHROME 未计入)+ 平台。协作行在 bridge 运行时渲;主题回退行在
        // 置顶 topicBar 跑不起来(topicBarOn=false,典型 Windows conhost)时把主题塞进页脚——与 :2082
        // 传给 FooterBar 的 `topic: topicBarOn?null:topic` 同一判定,口径单源不漂移。platform 让叶子
        // 对 win32 叠加静态余量(Windows fullscreen 重绘会把整屏刷进 scrollback,须前馈多留)。
        collabActive: !!(bridgeStatus && bridgeStatus.running),
        topicInFooter: !!(topic && !topicBarOn),
        platform: process.platform,
      },
      process.env
    );
  }

  // Shared sidebar props: ONE object feeds the SidebarPanel render in both
  // layout modes (startup side-by-side / post-first-message fill).
  // 确认规格:看板只展示任务清单/工具活动/消息队列 —— 主题、模型+强度、
  // 上下文用量已移除(页脚 FooterBar / 置顶 topicBar 的展示不受影响)。
  // Sidebar-visibility mirror for the notification callback (inline degrade
  // gate) + TTL filter: expired entries drop on the next repaint (the nowTick
  // heartbeat / any state render) — no dedicated timer.
  _sidebarVisibleRef.current = _sidebarOn || _railOut;
  const _notifyTtl = _notifyTtlMs(process.env);
  // Fade ratio from the sidebarLayout getter (fail-soft): the sidebar fades a
  // notification once it passes this fraction of its TTL. Passed via props so
  // buildSidebarLines stays a pure leaf (no env read); undefined → no fade.
  let _notifyFade;
  try {
    _notifyFade = require('../sidebarLayout').notifyFadeRatio(process.env);
  } catch {
    _notifyFade = undefined;
  }
  // Time base must match the heartbeat's active gate (see the nowTick effect):
  // once the turn settles nowTick stops updating, so a stale tick would make
  // new notifications' age negative → never expire. Fall back to Date.now()
  // whenever the heartbeat isn't running; drop negative ages (clock skew).
  const _hasActiveTurn = query.status && query.status !== 'idle' && query.status !== 'done';
  const _notifyNow = _hasActiveTurn && nowTick > 0 ? nowTick : Date.now();
  const _visibleNotifications = notifications.filter((n) => {
    if (!n || !Number.isFinite(n.timestamp)) {
      return false;
    }
    const age = _notifyNow - n.timestamp;
    return age >= 0 && age <= _notifyTtl;
  });
  const _sidebarProps = {
    taskLines: [],
    hideTaskSection: true,
    streaming: query.streaming,
    queueLen: query.queueLen || 0,
    notifications: _visibleNotifications,
    nowTick,
    now: _notifyNow,
    notifyTtl: _notifyTtl,
    notifyFadeRatio: _notifyFade,
    width: _sidebarWidthV,
  };
  // Reserve ledger note (任务#8/#11): the post-first-message board shares the
  // flex row with the left live column, so its rows do NOT add to the live
  // column height — the row height is max(left column, board). Anti scroll-
  // jump holds without a dedicated board reserve because BOTH operands are
  // individually bounded below `rows`: the left column via _streamReserve
  // (resolveStreamReserve keeps left + chrome < rows) and the board via the
  // sidebarFillRows CEILING (≤ rows - KHY_SIDEBAR_MIN_CHROME). 任务#11 (hug
  // content, no pad) only ever SHRINKS the board below that ceiling, so the
  // ledger can only decrease — no new reserve entry needed.

  // Fix 1b — khy 自己的 /命令·@文件 补全下拉横向对齐到输入光标列(门控
  // KHY_COMPLETION_FOLLOW_CURSOR 默认开)。复用 PromptFrame.layoutPromptRows 得同款宽度
  // 感知行模型,caretGeometry 求 caret 显示列,clamp 保不出屏;门控关 → 0=贴左逐字节 legacy。
  // 全程无副作用、纯计算;lazy require displayWidth(CJK 宽度)与 PromptFrame 同惰性哲学。
  let _completionMarginLeft = 0;
  if (completion.active && caretGeometry.completionFollowEnabled(process.env)) {
    try {
      const _cols = _railCols(80);
      // Single-slot memo keyed on (value, offset, cols): while the completion menu
      // is open and the user arrows through options (App re-renders on selectedIndex
      // with value/offset/cols UNCHANGED), skip re-laying-out the whole buffer +
      // caret geometry — byte-identical, gate KHY_COMPLETION_MARGIN_MEMO. Fail-soft.
      const _computeMargin = () => {
        let _measure;
        try {
          _measure = require('../../formatters').displayWidth;
        } catch {
          _measure = null;
        }
        const _layout = PromptFrame.layoutPromptRows({ value, offset, cols: _cols });
        const _caretCol = caretGeometry.caretColumn(
          _layout.rows,
          _measure ? { measure: _measure } : {}
        ).col;
        return caretGeometry.clampColumn(_caretCol, _cols, 24);
      };
      _completionMarginLeft = _caretMarginMemo
        ? _caretMarginMemo.memoCompletionMargin(value, offset, _cols, _computeMargin, process.env)
        : _computeMargin();
    } catch {
      _completionMarginLeft = 0;
    }
  }

  // Root box width — 右栏激活时 ink 的整棵树都必须收进 `cols - 栏宽`,让 Yoga 从源头就
  // 不往预留槽位排版;槽位由 sidebarRail 用绝对坐标带外画。判定复用上面的 _railContentCols
  // (与 effectiveCols 同一真源),门控关 → 0 → width 为 undefined → Yoga 照旧全宽自动布局。
  //
  // 快照推送:把这一帧的看板 props 交给画笔。纯赋值,不建行、不写 IO —— 真正 build 发生在
  // ink 写帧时的 paintBytes() 里,所以哪怕是别处触发的帧,画出来的也一定是最新快照。
  //
  // 根因 A(判定同源):每帧无条件把本帧的 sticky 解析尺寸推给画笔 —— 画笔的 railGeometry
  // 从此用与 ink 树收窄(_railContentCols)完全相同的输入导出几何,树内 SidebarPanel 与带外
  // 画笔在任意一帧互斥:_railOut=true ⇔ 画笔几何 on(同一对 cols/rows + 同一组纯门控),
  // 心跳帧间不再因两套判定源分歧而来回切换(抖动/重影)。
  try {
    sidebarRail.setDims(_resCols, _resRows);
  } catch {
    /* 辅助 UI */
  }
  // setChrome 同样每帧无条件推送:底边锚定所依赖的页脚 chrome 高度必须与本帧 ink 树
  // 完全一致,确保首帧绘制器即拿到正确锚点。几何 off 时 chrome 不被消费(零副作用),
  // 所以在非右栏帧调用也逐字节安全。同一组 collab/topic 布尔来自 resolveStreamReserve
  // 的单一来源,行数由 railLayout.railBottomChrome 纯叶子导出(App 只转发参数)。此
  // 用户要求的 BOTTOM 锚定 SUPERSEDES 项目记忆里较早的 top-right 锚定规则。
  try {
    sidebarRail.setChrome({
      collabActive: !!(bridgeStatus && bridgeStatus.running),
      topicInFooter: !!(topic && !topicBarOn),
    });
  } catch {
    /* 辅助 UI */
  }
  if (_railOut) {
    try {
      sidebarRail.setSnapshot(_sidebarProps);
    } catch {
      /* 辅助 UI */
    }
  }
  // 阶段四: push the board nav state and refresh the geometry ref the NEXT frame's
  // useSidebarNav will read. Fully gated on navOn — the legacy path never calls
  // setNav (the rail keeps its default offset 0 / index -1 → byte-identical paint)
  // and never runs the extra line-count measure. totalLines is the FULL (unfolded,
  // un-windowed) board length — buildSidebarLines with no maxRows/scrollOffset — so
  // the hook's center-follow clamp matches the slice the rail later paints.
  if (navOn) {
    try {
      const _navFull = SidebarPanel.buildSidebarLines({ ..._sidebarProps, width: _sidebarWidthV });
      _navGeomRef.current = {
        totalLines: Array.isArray(_navFull) ? _navFull.length : 0,
        visibleRows: sidebarRail.viewportRows(),
      };
      sidebarRail.setNav({
        scrollOffset: sidebarNav.scrollOffset,
        focusIndex: sidebarNav.focused ? sidebarNav.selectedIdx : -1,
      });
    } catch {
      /* 辅助 UI */
    }
  }
  // 独占输入的全屏覆盖层是否正挂载(→ 隐藏 PromptFrame / FooterBar,见下方注释)。
  // fail-soft:叶子不可用 → 回退历史「只认 modelPicker」判定。
  let _overlayOwnsLive;
  try {
    _overlayOwnsLive = overlayLiveBudget.ownsLiveRegion(
      { modelPicker: !!modelPicker, khyosOpen: !!khyosOpen },
      process.env
    );
  } catch {
    _overlayOwnsLive = !!modelPicker;
  }
  return h(
    Box,
    { flexDirection: 'column', width: _railContentCols || undefined },
    // Committed output (banner + transcript) via <Static>. Always mounted so
    // that suspending the live UI does not reprint scrollback.
    h(Static, { items: _bannerInLive ? query.staticItems.slice(1) : query.staticItems }, (item) => {
      if (item.kind === 'banner') {
        return h(WelcomeBanner, { key: 'banner', ...bannerProps, showArt: _bannerShowArt });
      }
      return h(Transcript.MessageBlock, { key: item.key, msg: item.msg, expanded });
    }),

    // Live region — suspended while an interactive command owns the terminal.
    // Structure: column [ row [ left column | board ], PromptFrame, footer &
    // overlays ]. The row boundary ends BEFORE PromptFrame so the prompt and
    // the footer keep the FULL terminal width. 任务#8/#11: the board stays in
    // the flex row in BOTH modes — at startup it tops the right column next
    // to the banner; after the first message its top edge sits right under
    // <Static> (message area's bottom edge) and its height HUGS the content,
    // capped by sidebarFillRows. <Static> stays OUTSIDE (ink extracts it).
    // alignItems flex-start keeps both columns TOP-ALIGNED so the board's bg
    // block covers exactly its content rows (never stretched to the left
    // column's height).
    inputActive
      ? h(
          Box,
          { key: 'live', flexDirection: 'column' },
          h(
            Box,
            { flexDirection: 'row', alignItems: 'flex-start' },
            h(
              Box,
              { flexDirection: 'column', flexGrow: 1 },
              // Startup-only banner (task #23): lives here so the version line tops
              // the left column exactly where the sidebar tops the right column.
              _bannerInLive
                ? h(WelcomeBanner, { key: 'live-banner', ...bannerProps, showArt: _bannerShowArt })
                : null,
              // Removable Ctrl+O detail for the latest committed <Static> turn.
              // MessageBlock already force-expands role:'expansion'; keeping this
              // outside Static makes the second keypress a true collapse.
              committedExpansion
                ? h(Transcript.MessageBlock, {
                    key: 'committed-expansion',
                    msg: committedExpansion,
                  })
                : null,
              // Live streaming turn. 任务#12: while the board is visible this block only
              // spans the LEFT column, so its wrap/height budgets must use the left-
              // column width (contentWidth) — board off → null → legacy full width.
              query.streaming
                ? h(StreamingBlock, {
                    streaming: query.streaming,
                    status: query.status,
                    expanded,
                    reserveRows: _streamReserve == null ? null : _streamReserve + extraReserve,
                    contentWidth: (_sidebarOn || _railOut) && _mainColsV > 0 ? _mainColsV : null,
                  })
                : null,
              query.status === 'done' ? h(Text, { dimColor: true }, '✱ 完成') : null,

              // Plan-mode surface (stage 3): generation preview, approval view, or the
              // execution spinner. Step progress itself lands in the transcript.
              planPhase === 'generating'
                ? h(PlanApproval, { generating: true, genText: planGenText })
                : null,
              planPhase === 'reviewing' ? h(PlanApproval, { plan: currentPlan }) : null,
              planPhase === 'executing'
                ? h(Box, { marginTop: 1 }, h(Spinner, { label: '执行计划中…' }))
                : null,

              // Shell peek panel (块4 SUBVIEW): live tool command + output, ↓ to open
              // while executing, ← to return, ↑/↓ to scroll.
              shellViewOpen
                ? h(ShellView, { streaming: query.streaming, scroll: shellScroll })
                : null,

              // Transcript 视图(CC app:toggleTranscript):全量会话的可滚动回看,
              // Ctrl+O 开关。行数组与视口高度由 _transcriptView 一次算好,键位分支
              // 与组件切片共用同一组数字。
              transcriptOpen && _transcriptView
                ? h(TranscriptView, {
                    lines: _transcriptView.lines,
                    scroll: transcriptScroll,
                    showAll: expanded,
                    rows: _resRows,
                  })
                : null,

              busy && !awaitingUserChoice
                ? query.status === 'compacting'
                  ? h(CompactionProgress, { compaction: query.compaction })
                  : h(
                      Box,
                      { marginTop: 1, flexDirection: 'column' },
                      h(Spinner, {
                        label: _getStatusLabel(
                          query.status,
                          _liveActivity(query.status, query.streaming, query.statusDetail) ||
                            _taskActivity()
                        ),
                        detail: query.statusDetail,
                        ..._spinnerProgress(
                          query.turnStartedAt,
                          nowTick,
                          lastActivityRef.current,
                          query.streaming
                        ),
                      }),
                      ...(query.queueLen > 0 ? _renderQueuePanel(query.queueItems) : []),
                      ...(query.steerLen > 0
                        ? [
                            h(
                              inkRuntime.get().Text,
                              { key: 'steer-pending', dimColor: true },
                              `  ⟳ ${query.steerLen} 条方向修正待注入（下一个工具边界生效）`
                            ),
                          ]
                        : []),
                      // Discoverability of the interrupt affordance (对齐 CC isLoading footer
                      // "esc to interrupt"). Only when NOTHING is queued — with a queue the
                      // panel above already shows the accurate two-step "Esc 取回并清空；再按
                      // Esc 打断". Decision + text live in the interruptHint leaf; gated by
                      // KHY_ESC_INTERRUPT_HINT (default on). Empty string → nothing rendered.
                      ...(() => {
                        const hint = interruptHint.buildInterruptHint({
                          busy: true,
                          queueLen: query.queueLen,
                          compacting: query.status === 'compacting',
                          awaitingChoice: awaitingUserChoice,
                        });
                        return hint
                          ? [
                              h(
                                inkRuntime.get().Text,
                                { key: 'esc-interrupt-hint', dimColor: true },
                                `  ⎋ ${hint}`
                              ),
                            ]
                          : [];
                      })()
                    )
                : null,

              // Help overlay.
              showHelp ? h(HelpMenu, null) : null,

              // Input mode indicator (CC PromptInputModeIndicator).
              bashMode
                ? h(Text, { color: 'magenta' }, '! BASH 模式 · Enter 运行 shell 命令')
                : null,
              memoryMode
                ? h(Text, { color: 'green' }, '# 记忆模式 · Enter 写入记忆（下次对话生效）')
                : null,

              // Staged image attachments (Ctrl+V). Each item has its own clickable
              // delete control; labels are recomputed from the surviving list so
              // deleting 图2 leaves 图1 intact and keeps payload order stable.
              pendingImages.length > 0
                ? h(
                    Box,
                    { flexDirection: 'row', flexWrap: 'wrap', columnGap: 1 },
                    h(Text, { color: 'blue' }, `📎 已附加 ${pendingImages.length} 张图片：`),
                    ...pendingImageAttachments.labels(pendingImages).map((item) =>
                      h(
                        Box,
                        {
                          key: item.id,
                          flexShrink: 0,
                          onClick: () => removePendingImage(item.id),
                        },
                        h(Text, { color: 'cyan', bold: true }, `${item.label} ×`)
                      )
                    ),
                    h(Text, { color: 'blue', dimColor: true }, ' · Enter 发送 · Ctrl+V 再加 · Esc 清除')
                  )
                : null,

              // Vim mode indicator (CC PromptInputModeIndicator). Only while /vim is on.
              vimEnabled
                ? h(
                    Text,
                    { color: vimMode === 'NORMAL' ? 'green' : 'yellow', bold: true },
                    vimMode === 'NORMAL' ? '-- NORMAL --' : '-- INSERT --'
                  )
                : null,

            ), // end left column
            // Right-column board (任务#8/#11) — always inside the flex row:
            //  - startup (_bannerInLive): STABLE height, version-line offset so the
            //    board's top edge shares the terminal row with the banner's version
            //    line (task #23 left/right split; behaviour unchanged).
            //  - post-first-message: top edge on the row's FIRST line (the message
            //    area's bottom edge); height HUGS the content (fitContent — two
            //    content lines paint two rows, no filler) and only grows with the
            //    task list up to the sidebarFillRows ceiling (honest “… 其余 N 行”
            //    marker beyond it). The row's alignItems flex-start keeps the bg
            //    block from stretching to the left column's height.
            //
            // 右栏模式(_railOut)例外:看板已经出树,改由 runtime/sidebarRail 在预留槽位里用
            // 绝对坐标带外画。任务#7:看板底边锚定在输入框下线(FooterBar 高度由 setChrome 前馈),
            // 内容向上生长 —— 覆盖旧的顶部/右上角锚定规则。这里必须返回 null,否则同一份内容会在
            // 活动区里再画一遍。外层 flex 行与 alignItems 刻意保留不动(diff 最小),右列为空时
            // Yoga 的行高就是左列高度,与今天一致。
            _sidebarOn && !_railOut
              ? _bannerInLive
                ? h(
                    Box,
                    {
                      flexDirection: 'column',
                      flexShrink: 0,
                      justifyContent: 'flex-start',
                      marginTop: _bannerVersionOffset,
                    },
                    h(SidebarPanel, {
                      ..._sidebarProps,
                      stableRows: _sidebarStableRowsV,
                      fitContent: true,
                    })
                  )
                : h(
                    Box,
                    {
                      // Top-right anchor (post-first-message): pin the hugging board
                      // to the row's top edge explicitly (alignSelf flex-start) so it
                      // can never ride the bottom of a tall left column; no banner
                      // offset here (startup branch above owns that).
                      flexDirection: 'column',
                      flexShrink: 0,
                      justifyContent: 'flex-start',
                      alignSelf: 'flex-start',
                    },
                    h(SidebarPanel, {
                      ..._sidebarProps,
                      stableRows: _sidebarFillRowsV,
                      fitContent: true,
                    })
                  )
              : null
          ), // end upper row — everything below stays full terminal width

          // Canonical task checklist: full-width sibling between the latest
          // transcript/live content and the prompt. The existing heartbeat keeps
          // store and plan status changes current; coordinated empty lines unmount it.
          h(TaskListPanel, {
            key: 'task-panel',
            tick: nowTick,
            ..._taskProps,
            ...(tasksHidden ? { lines: [], hidden: 0, hiddenLines: [] } : {}),
          }),

          // Prompt input. Hidden while an input-owning full-screen overlay is
          // mounted: rendering PromptFrame + FooterBar + overlay together grows the
          // live region past the terminal height, which desyncs ink's erase-line
          // accounting after static output (see pendingGatewayNoticeRef comment)
          // and visually duplicates the prompt chrome. Such an overlay owns input
          // while open (top-level useInput yields), so hiding the frame is safe.
          // 判定收敛到 overlayLiveBudget:除 ModelPicker 外,/khyos 的 KhyOsView 同样独占
          // 输入且自身已占 rows-3,再叠输入框/页脚必然触发 ink 全屏重绘(win32 每帧往
          // scrollback 堆一份永久副本 =「输出重复两次 + 输入框残影」)。
          _overlayOwnsLive
            ? null
            : h(PromptFrame, {
                value,
                offset,
                busy,
                placeholder,
                accent,
                vimMode: vimEnabled ? vimMode : null,
                mic: { active: dictating, onClick: toggleDictation },
              }),

          // Completion dropdown (slash / @file).
          completion.active
            ? h(CompletionMenu, { completion, selectedIndex, marginLeft: _completionMarginLeft })
            : null,

          // Reverse-incremental history search prompt (Ctrl+R). Thin read-only
          // overlay; state comes from the historyReverseSearch leaf.
          revSearch && _HistorySearchOverlay
            ? h(_HistorySearchOverlay, { state: revSearch })
            : null,

          // Transient double-press affordance ("再按一次 Ctrl-C 退出" 等).
          hint ? h(Text, { dimColor: true }, hint) : null,

          // Footer. When the pinned topic bar is unavailable, the current topic is
          // shown here as a fallback (块3 degraded path).
          // (FooterBar likewise hidden while an input-owning overlay is open — see above.)
          _overlayOwnsLive
            ? null
            : h(FooterBar, {
                ...footer,
                contextTokens: query.contextTokens || 0,
                contextPlan: query.contextPlan,
                permissionMode,
                localMode,
                fastMode,
                voiceMode,
                topic: topicBarOn ? null : topic,
                bridge: bridgeStatus,
                goalActive,
              }),

          // Control-request overlay: AskUserQuestion → selection menu, else permission.
          query.controlRequest
            ? isQuestionRequest(query.controlRequest)
              ? h(QuestionPrompt, {
                  request: query.controlRequest.request,
                  onResolve: query.resolveControl,
                })
              : h(PermissionsPrompt, {
                  request: query.controlRequest.request,
                  onResolve: query.resolveControl,
                })
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
          khyosOpen ? h(KhyOsView, { onExit: () => setKhyosOpen(false) }) : null,

          // 会话拓扑「森林」只读面板(/topology view)。TopologyPanel 自身只着色;
          // 走树/字形/标签全来自共享 SSOT(sessionTopology)。Esc/Enter 关闭(主
          // useInput 0d 分支消费)。
          topologyView
            ? h(
                Box,
                { flexDirection: 'column' },
                h(TopologyPanel, {
                  forest: topologyView.forest,
                  currentId: topologyView.currentId,
                  degraded: topologyView.degraded,
                }),
                h(Text, { dimColor: true }, '（Esc / 回车 关闭)')
              )
            : null
        )
      : null
  );
}

module.exports = App;
// Exported for unit tests: status-line label composition + live activity read.
module.exports._getStatusLabel = _getStatusLabel;
module.exports._resolveBannerProps = _resolveBannerProps;
module.exports._taskActivity = _taskActivity;
module.exports._liveActivity = _liveActivity;
module.exports._spinnerProgress = _spinnerProgress;
module.exports._queuePanelLines = _queuePanelLines;
module.exports._liveClampBoundaryDecision = _liveClampBoundaryDecision;
