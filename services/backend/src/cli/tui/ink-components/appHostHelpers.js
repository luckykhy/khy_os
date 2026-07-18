'use strict';

/**
 * appHostHelpers — App.js 的模块作用域助手函数(React 闭包无关),抽出以降上帝文件
 * (god-file split · DESIGN-ARCH-051 lineage，范式同 localBrainProviderConfig /
 * queryBridgeTimeline)。两簇:①权限模式应用 + 任务面板行读取(_readMergedTaskLines·
 * PERMISSION_MODES·applyPermissionMode);②状态行 / spinner / token / 队列面板派生
 * (_getStatusLabel·_liveActivity·_estimateTok·_spinnerProgress·_queuePanelLines·
 * _renderQueuePanel 等)。皆不触碰 App() 的 React 闭包 state,故可脱离组件单测;App.js 以
 * **同名 re-import** 接回,契约字节不变。注:applyPermissionMode 会改 permissionStore /
 * toolCalling 单例(有副作用),故本叶子 **刻意 NOT 声明为纯零 IO 叶子**。_renderQueuePanel
 * 需 React / inkRuntime,故在此就地 require(与 App.js 同相对路径)。
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');

// Single-slot memo of the mergeTaskLines parse (pure fn of snap+planTasks) so the
// checklist isn't re-split/re-deduped every render (incl. every keystroke) when the
// task state is unchanged. Fail-soft require; gate KHY_TASK_LINES_MEMO. Missing
// module / gate off → direct compute (byte-identical to today). See taskLinesMemo.js.
let _taskLinesMemo = null;
try { _taskLinesMemo = require('./taskLinesMemo'); } catch { _taskLinesMemo = null; }
// taskPanelLines.mergeTaskLines is the single source for the merged checklist
// lines; lazily required & fault-isolated (the task stores are auxiliary).
function _readMergedTaskLines() {
  try {
    if (process.env.KHY_TASK_PANEL === '0') return [];
    const taskStore = require('../../../tools/_taskStore');
    const snap = typeof taskStore.snapshot === 'function' ? taskStore.snapshot() : '';
    let planTasks = null;
    if (process.env.KHY_PLAN_TASK_PANEL !== '0') {
      const panelState = require('../../../services/taskPanelState');
      planTasks = typeof panelState.getTasks === 'function' ? panelState.getTasks() : null;
    }
    const { mergeTaskLines } = require('./taskPanelLines');
    const _compute = () => mergeTaskLines(snap, planTasks);
    return _taskLinesMemo
      ? _taskLinesMemo.memoMergeTaskLines(snap, planTasks, _compute, process.env)
      : _compute();
  } catch { return []; }
}

// Permission modes cycled by Shift+Tab. The cycle is 5-wide
// (default → acceptEdits → plan → auto → bypass), mirroring Claude Code's
// Shift+Tab order (auto/bypass slot after plan). `acceptEdits` is CC's
// "auto-accept edits" sweet spot (non-destructive fs edits auto-approved,
// shell/destructive still prompt); `auto` auto-approves routine calls but still
// prompts for destructive/high-risk (deterministic riskGate analog of CC's
// classifier-gated auto). The sixth CC mode, `dontAsk`, is startup/settings only
// (KHY_PERMISSION_MODE=dontAsk) and intentionally NOT in the cycle — matching CC.
// Each mode maps to a KHY permissionStore profile that actually gates tool
// execution — see applyPermissionMode(). NOTE: the old readline REPL's modes
// were default/auto/bypass with an inverted bypass→strict mapping; we use CC's
// clearer semantics (bypass = allow everything).
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypass'];

// Apply a permission mode to the real tool-gating singletons. The TUI state
// alone is cosmetic — tool execution is gated by permissionStore._profile (and
// toolCalling dangerousMode when present), so we must push the change through.
//
// The mode→profile correspondence is NOT defined here: toolCalling owns the
// single source of truth (permissionModeToProfile). This is the user's durable
// cycle choice, so we persist it (setProfile defaults to persist:true), whereas
// toolCalling.setPermissionMode only syncs the in-memory profile.
function applyPermissionMode(mode) {
  let profile = 'normal';
  let toolCalling = null;
  try {
    toolCalling = require('../../../services/toolCalling');
    profile = toolCalling.permissionModeToProfile
      ? toolCalling.permissionModeToProfile(mode)
      : 'normal';
  } catch { /* toolCalling unavailable — fall back to 'normal' */ }
  try {
    require('../../../services/permissionStore').setProfile(profile);
  } catch { /* permissionStore unavailable */ }
  try {
    if (!toolCalling) toolCalling = require('../../../services/toolCalling');
    // setDangerousMode was never exported (silent no-op); use the real toggles.
    if (mode === 'bypass') {
      toolCalling.enableDangerousMode();
      toolCalling.acknowledgeDangerousMode();
    } else {
      toolCalling.disableDangerousMode();
    }
  } catch { /* toolCalling unavailable */ }
}

// A control request is an AskUserQuestion when its inner request targets the
// AskUserQuestion tool — those are rendered as a selection menu (QuestionPrompt)
// rather than the y/n/a permission overlay.
function _normToolName(n) {
  return String(n || '').toLowerCase().replace(/[\s_-]/g, '');
}
function isQuestionRequest(cr) {
  const r = cr && cr.request;
  return !!r
    && String(r.subtype || '').toLowerCase() === 'can_use_tool'
    && _normToolName(r.tool_name || r.tool) === 'askuserquestion';
}

// True when /learn would fall into its offline interactive mode (inquirer loop),
// which only happens when no gateway adapter is available. With a model present
// /learn just prints/forwards and is safe to run inside the TUI.
function _learnNeedsClassic() {
  try {
    const gateway = require('../../../services/gateway/aiGateway');
    const status = typeof gateway.getStatus === 'function' ? gateway.getStatus() : [];
    return !Array.isArray(status) || status.length === 0;
  } catch {
    return false;
  }
}

// Return a human label when a routed command would invoke inquirer / readline
// (which cannot share ink's managed input and crashes the TUI), else null. The
// check is subcommand-aware so safe variants (e.g. `/pool` status, `/publish`
// check, `/docs maintainer`) still run normally. Auth commands (login/register/
// passwd) and `/model` are handled by native overlays before this is consulted.
function tuiUnsupportedReason(parsed) {
  if (!parsed) return null;
  const cmd = parsed.command;

  switch (cmd) {
    case 'forgot': return '找回密码';
    // cloud/app/docs/pool/publish/ai-owner/init and the gateway menu family
    // (incl. /plugin gateway delete, reached via handleGatewayConfig) now collect
    // input through the native uiPrompt bridge (promptCompat → FormFlow), so they
    // run inside the TUI.
    case 'learn': return _learnNeedsClassic() ? '离线课程交互（无可用模型）' : null;
    default: break;
  }

  // NOTE: /rollback /worktree /review /study /intent /mind are now executed
  // NATIVELY inside the TUI (runRouted async block + dispatchNativeCommand), so
  // they never reach here. They are intentionally NOT listed as "needs classic
  // mode" — that would contradict the goal 「我只要使用 tui」.
  return null;
}

// Live activity label for the in_progress V2 task (CC present-continuous
// activeForm, e.g. "Fixing auth bug"). Lazy-required and fault-isolated so the
// TUI never crashes if the task store is unavailable. Empty string when nothing
// is running — this is what makes activeForm a consumed field rather than a
// write-only one.
function _taskActivity() {
  try {
    const taskStore = require('../../../tools/_taskStore');
    if (taskStore && typeof taskStore.currentActivity === 'function') {
      return taskStore.currentActivity() || '';
    }
  } catch { /* task store unavailable — fall back to the static label */ }
  return '';
}

function _getStatusLabel(status, activity) {
  const labels = { thinking: '思考中…', streaming: '生成中…', tool: '执行工具…', compacting: '正在压缩对话…', local: '本地处理中…' };
  const base = labels[status] || '思考中…';
  const detail = (activity || '').trim();
  return detail ? `${base} · ${detail}` : base;
}

// Lazily-bound shared live-activity deriver (single source: statusLabels). Turns
// the live turn state into a concrete "what is happening right now" string — the
// running tool's target, the current reasoning, or the gateway detail — so the
// spinner stops saying a bare phase word and a stall shows WHAT it is stuck on.
let _deriveLiveActivityFn = null;
function _liveActivity(status, streaming, statusDetail) {
  if (_deriveLiveActivityFn === null) {
    try { _deriveLiveActivityFn = require('../../repl/statusLabels').deriveLiveActivity || false; }
    catch { _deriveLiveActivityFn = false; }
  }
  if (!_deriveLiveActivityFn) return '';
  try {
    // Running tool = the last tool chunk that has not yet resolved.
    let runningTool = null;
    const tools = (streaming && Array.isArray(streaming.tools)) ? streaming.tools : [];
    for (let i = tools.length - 1; i >= 0; i -= 1) {
      const t = tools[i];
      if (t && !t.result) { runningTool = { name: t.name || t.toolName || t.tool, input: t.input }; break; }
    }
    const thinkingTail = (streaming && streaming.thinking) ? String(streaming.thinking).slice(-200) : '';
    return _deriveLiveActivityFn({ status, runningTool, thinkingTail, statusDetail }) || '';
  } catch { return ''; }
}

// CC parity gate for the live spinner token hint. CC (src/components/Spinner.tsx:244)
// estimates `Math.round(responseLength / 4)` where `responseLength` accumulates ONLY
// the streamed RESPONSE TEXT deltas (REPL.tsx:3305, reset per turn) — thinking is NOT
// counted. Default on aligns Khy to that backend logic: estimate the visible answer
// only (exclude thinking) and use round (not ceil) for the char fallback. Set
// KHY_SPINNER_CC_TOKENS ∈ {0,false,off,no} → legacy (text+thinking, ceil), byte-identical.
function _spinnerCcTokensEnabled(env = process.env) {
  const v = String((env && env.KHY_SPINNER_CC_TOKENS) || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

// Lazily-bound token estimator (shared backend heuristic) for the live "~N tok"
// progress hint on the spinner. Prefers the real tokenizer estimate; the char
// fallback matches CC's `round(len/4)` (legacy used ceil, kept under gate-off).
let _estimateTokFn = null;
// Incremental token-estimate leaf: turns the per-frame full-string CJK rescan of
// the growing streamed answer (O(N)/frame → O(N²)/turn) into a delta-only scan,
// byte-identical to estimateTokens. Only applied on the CC-tokens path where
// `text` = pure streaming.text (append-only, prefix-stable). Fail-soft require;
// gate KHY_SPINNER_TOKEN_INCREMENTAL default-on → gate off / absent = today.
let _spinnerTokInc = null;
try { _spinnerTokInc = require('./spinnerTokenEstimate'); } catch { _spinnerTokInc = null; }
function _estimateTok(text, env = process.env, resetKey = null) {
  if (!text) return 0;
  if (_estimateTokFn === null) {
    try { _estimateTokFn = require('../../../services/tokenUsageService').estimateTokens || false; }
    catch { _estimateTokFn = false; }
  }
  try {
    if (_estimateTokFn) {
      // resetKey != null ⇒ caller vouches `text` is append-only within this turn
      // (CC-tokens path). Route through the incremental leaf; it falls back to the
      // full estimator byte-identically when gated off or on a turn reset.
      if (resetKey != null && _spinnerTokInc) {
        return _spinnerTokInc.estimateIncremental(text, _estimateTokFn, resetKey, env) || 0;
      }
      return _estimateTokFn(text) || 0;
    }
  } catch { /* fall through to the char heuristic */ }
  // CC parity: round(len/4); legacy (gate off): ceil(len/4).
  const len = String(text).length;
  return _spinnerCcTokensEnabled(env) ? Math.round(len / 4) : Math.ceil(len / 4);
}

// Derive the spinner's progress props from the turn clock + live stream. Pure
// (time passed in) so it is unit-testable: elapsed seconds since turn start, a
// streamed-token estimate, and a stall flag when output has paused > 3s.
function _spinnerProgress(turnStartedAt, nowTick, lastActivityAt, streaming, env = process.env) {
  const now = nowTick || Date.now();
  const started = turnStartedAt || 0;
  const elapsedSec = started ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const stalled = !!lastActivityAt && (now - lastActivityAt) > 3000;
  let tokens = 0;
  // _spinnerProgress runs in App's RENDER body (every frame while busy, plus the
  // 1s nowTick), and _estimateTok re-scans the WHOLE growing streaming.text each
  // time — O(len)/frame → O(len²)/turn. But the tokens are only DISPLAYED once
  // Spinner.buildSpinnerMeta reveals the meta (spinnerMeta.shouldShowTimerAndTokens:
  // hidden for the first 30s, where buildSpinnerMeta returns '' without reading
  // tokens). So skip the estimate while the meta is provably hidden — byte-safe at
  // the render layer. Conservative: only skip when the reveal gate positively says
  // hidden; gate off / leaf unavailable → estimate as today (gate KHY_SPINNER_TOKEN_LAZY).
  let _needEstimate = true;
  try {
    _needEstimate = require('./spinnerTokenLazy').shouldEstimateSpinnerTokens({ elapsedSec, env });
  } catch { _needEstimate = true; }
  if (streaming && _needEstimate) {
    // CC parity: the live token hint estimates the streamed RESPONSE TEXT only
    // (CC's responseLength excludes thinking). Gate off → legacy (text + thinking).
    const cc = _spinnerCcTokensEnabled(env);
    const text = cc
      ? (streaming.text || '')
      : ((streaming.text || '') + (streaming.thinking || ''));
    // On the CC path `text` = pure streaming.text, append-only within a turn → pass
    // turnStartedAt as the incremental reset key (new turn ⇒ full rescan). Legacy
    // composite (text+thinking) is NOT prefix-stable → resetKey null = full scan.
    tokens = _estimateTok(text, env, cc ? (turnStartedAt || 0) : null);
  }
  return { elapsedSec, tokens, stalled };
}

// Build the queue panel as plain text rows (pure → unit-testable). Each row is
// the verbatim (whitespace-collapsed, truncated) queued message; the last row is
// tagged "↑ 取回" and a trailing summary line is appended.
function _queuePanelLines(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const MAX_SHOWN = 5;
  const lastIdx = list.length - 1;
  const rows = [];
  list.slice(0, MAX_SHOWN).forEach((raw, i) => {
    const oneLine = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    const text = oneLine.length > 56 ? `${oneLine.slice(0, 56)}…` : oneLine;
    const tail = i === lastIdx ? '  ↑ 取回' : '';
    rows.push(`  ${i + 1}. ${text}${tail}`);
  });
  if (list.length > MAX_SHOWN) {
    rows.push(`  …还有 ${list.length - MAX_SHOWN} 条`);
  }
  rows.push(`  ⏳ ${list.length} 条排队（↑ 取回最后一条，Esc 取回并清空；再按 Esc 打断）`);
  return rows;
}

// Render the pending "send while busy" queue verbatim so the user can see each
// waiting message and knows the last one can be pulled back with ↑. Returns an
// array of elements (spread into the busy column).
function _renderQueuePanel(items) {
  // Module-scoped helper: `h`/`Text` from App()'s closure are NOT in scope here,
  // so resolve them locally. React (top of file) + inkRuntime are module-level.
  const h = React.createElement;
  const { Text } = inkRuntime.get();
  return _queuePanelLines(items).map((line, i) =>
    h(Text, { key: `q${i}`, dimColor: true }, line));
}

// live clamp 的回合边界判定(纯逻辑,导出给单测)。
// changed: turnKey 是否变化; reset: 是否必须先把旧轮 reserve 清零; sample: 本帧是否允许采样。
// 规则:
//   1. 新轮/轮结束 且 extraReserve!==0 → 先 reset,本帧不采样;
//   2. 新轮但 extraReserve===0 → 允许首帧立即采样(修复 Windows 首帧 fullscreen 重刷);
//   3. 同一轮且 turnKey 非空 → 采样; idle/null → 不采样。
function _liveClampBoundaryDecision(prevTurnKey, nextTurnKey, extraReserve) {
  const changed = prevTurnKey !== nextTurnKey;
  const reset = changed && Number(extraReserve || 0) !== 0;
  const sample = !reset && nextTurnKey != null;
  return { changed, reset, sample };
}

module.exports = {
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
};
