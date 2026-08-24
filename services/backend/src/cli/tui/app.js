'use strict';

const React = require('react');
const inkRuntime = require('./inkRuntime');

/**
 * startInkApp — Entry point for the Ink (React) TUI.
 *
 * Loads the official ESM `ink` package (via dynamic import bridged through
 * inkRuntime), mounts <App/>, and blocks until exit. Ink owns stdin, raw mode,
 * resize handling and rendering — we no longer touch process.stdin directly.
 */
async function startInkApp(options = {}) {
  // Install global crash-recovery safety net so unhandled rejections /
  // uncaught exceptions log to stderr instead of silently terminating the
  // TUI process. The server entry (server.js) has its own install; this
  // covers the Ink CLI path which previously lacked it. exitOnUnknown:false
  // keeps the interactive contract of bin/khy.js (log, never exit on unknown
  // background errors) — only fatal/config errors may still exit.
  try {
    const crashRecovery = require('../../services/crashRecovery');
    crashRecovery.install({ logger: console, exitOnUnknown: false });
  } catch { /* crashRecovery unavailable — degrade gracefully */ }

  // Ensure JSX requires work and the ink namespace is resolved before mount.
  inkRuntime.registerJsx();
  const { render } = await inkRuntime.loadInk();

  // App is a .jsx component; require AFTER registerJsx() so babel transpiles it.
  const App = require('./ink-components/App');

  // React development 渲染每帧调 performance.measure 且从不清理 → 数小时后累积到百万条
  // (MaxPerformanceEntryBufferExceededWarning 实证),内存/性能持续劣化 → TUI 越用越卡、搜索
  // 转圈数小时。安装周期清理(门控 KHY_PERF_ENTRY_REAP 默认 on;关 → 不装,字节回退今日行为)。
  try {
    require('./perfEntryReaper').installPerfReaper({ env: process.env });
  } catch { /* 清理器 best-effort,绝不影响 TUI 启动 */ }

  // Mark the Ink TUI as the active interactive surface for the whole process.
  // Service-layer handlers routed in-process (e.g. /review's auto-fix confirm)
  // read this to AVOID inquirer, which fights ink for stdin (raw mode) and
  // topples the entire UI. Stays set for the process lifetime — the flag is a
  // "the terminal is owned by ink" signal, not a per-turn state.
  process.env.KHY_INK_TUI_ACTIVE = '1';

  // The graceful-shutdown handler (bootstrap/shutdown.js) owns SIGINT and calls
  // process.exit(0) — which can win the race against the code after
  // waitUntilExit() below, so the resume hint would never print on a Ctrl-C that
  // routes through there. Register the hint as a shutdown hook too; the once
  // guard inside printInkResumeHint keeps it to a single line across both paths.
  try {
    require('../../bootstrap/shutdown').addShutdownHook('ink-resume-hint', async () => {
      printInkResumeHint();
    });
  } catch { /* shutdown module optional — waitUntilExit path still prints */ }

  // Scrollback preservation (门控 KHY_PRESERVE_SCROLLBACK 默认开): wrap the stdout
  // we hand to ink in a Proxy that normalizes ink's clearTerminal frame. **平台对称**:
  // 两类终端都只**剥离** `[3J`(清回滚缓冲),`[2J`/`[H` 原样透传。
  // 历史上 win32 分支曾反向**注入** `[3J` 去压制重复帧,现已刻意移除 —— 注入会
  // 直接清空用户正在查看的原生 scrollback,代价高于它修的重复症状
  // (判断见 scrollbackPreserve.js 头注)。因此 win32 的重复帧改为**从源头不触发**:
  // 让 live 区高度恒 < rows(liveRegionBudget / liveHeightClamp / overlayLiveBudget 三层),
  // 而不是事后拿 3J 擦。ink emits `clearTerminal + fullStaticOutput + output` as a
  // single write() when the live region height >= rows (ink.js:327 / instance.js:132);
  // non-win32 clearTerminal is `[2J[3J[H` and the `3J` wipes native scrollback
  // — which is exactly why long output「滚不到中间」on those terminals; win32 的 clearTerminal
  // 是 `[2J[0f`(本就无 3J 可剥),conhost 的 `2J` 把旧帧**滚进** scrollback 而非
  // 就地擦除 → 一旦触发全屏分支就留一份永久副本。We only override
  // write(); every other property (columns/rows/isTTY/on('resize')/syncOutput backing)
  // is delegated to the real process.stdout so ink's sizing/resize/sync semantics are
  // unchanged. Not touching process.stdout itself means no teardown is required and
  // non-ink bare writes (topicBar OSC title, etc.) are unaffected. Gate off →
  // normalizeClearTerminal is a byte-identical passthrough → behaves like today.
  //
  // The same write() override is also where the RIGHT RAIL task board paints
  // (门控 KHY_SIDEBAR_RAIL, 默认开). sidebarRail.clearBytes()/paintBytes() perform
  // no IO — they return absolute-cursor bytes (DECSC … CSI r;cH … DECRC, never a
  // newline). 顺序是根因级的关键:清槽位字节在 ink 帧之前、重绘字节在之后。
  // ink 帧提交 <Static> 新消息时会滚屏 —— 屏上旧看板像素若仍在,就会被整屏
  // 一起卷进 scrollback 形成残影(旧主题/模型行反复堆叠)。先清后写再画,
  // 滚上去的只有空格;三段拼进 ONE write(),槽位永远不会被观察到「已清未画」。
  // Gate off / non-TTY / narrow terminal → '' → the concatenation is skipped
  // entirely and this stays byte-identical to today.
  const scrollbackPreserve = require('./scrollbackPreserve');
  const sidebarRail = require('./runtime/sidebarRail');
  const _realOut = process.stdout;
  const _clearNormalizer = scrollbackPreserve.createClearTerminalNormalizer(
    process.env,
    process.platform
  );
  const _tuiStdout = new Proxy(_realOut, {
    get(target, prop) {
      if (prop === 'write') {
        return function (chunk, ...rest) {
          const normalized = _clearNormalizer.write(chunk);
          const frame = typeof normalized === 'string' ? normalized : String(normalized || '');
          const forceRailPaint = /\n|\r|\x1b\[2J|\x1b\[3J/.test(frame);
          let pre = '';
          let rail = '';
          try { pre = sidebarRail.clearBytes(forceRailPaint); } catch { pre = ''; } // 辅助 UI,永不拖垮渲染
          try { rail = sidebarRail.paintBytes(forceRailPaint); } catch { rail = ''; }
          return target.write((pre || rail) ? pre + normalized + rail : normalized, ...rest);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v; // bind back to real stdout — avoid `this` drift
    },
  });

  // Optional legacy bottom anchor (KHY_TUI_ANCHOR_BOTTOM, default off). The
  // default renders the first Ink frame immediately after pre-TUI output, so
  // the login line and welcome/version banner stay contiguous. Explicitly
  // enabling the gate restores the old bottom-aligned first frame. The pure
  // leaf returns '' on non-TTY / gate off; the write is best-effort.
  try {
    const _pad = require('./startupAnchor').anchorBottomPad(_realOut, process.env);
    if (_pad) _realOut.write(_pad);
  } catch { /* cosmetic — never block the TUI on the pad */ }

  // Mouse layer. Two separate things happen here, in this order:
  //
  // 1. UNCONDITIONAL sanitize. Mouse tracking is a sticky terminal mode: a khy
  //    session killed hard (SIGKILL / closed window) never ran its exit hook, so
  //    the terminal stays in tracking mode and the user loses wheel-scroll and
  //    click-drag selection in EVERY later command — with no way to guess why.
  //    disableBytes() resets all tracking modes; DECRST on a mode that was never
  //    set is a no-op, so writing it unconditionally costs nothing and heals a
  //    terminal a previous crash left broken.
  // 2. Opt-in enable. KHY_MOUSE_BUTTONS is OFF by default on every platform
  //    (see mouseButtons.js「为什么默认全关」): tracking is exclusive, so buying
  //    clickable <Box onClick> buttons costs the user scrollback + copy. The two
  //    clickable elements both have keyboard equivalents (Alt+M for the mic, Esc
  //    to clear pending images), so the default keeps the terminal intact.
  //    Enabled BEFORE ink mounts so no click is lost; exit hooks restore.
  try {
    const mouseButtons = require('./mouseButtons');
    if (_realOut.isTTY) {
      _realOut.write(mouseButtons.disableBytes());
    }
    if (mouseButtons.mouseButtonsEnabled(process.env, process.platform) && _realOut.isTTY) {
      const _hover = mouseButtons.mouseHoverEnabled(process.env);
      _realOut.write(mouseButtons.enableBytes({ hover: _hover }));
      let _mouseHooked = false;
      const offMouse = () => {
        if (_mouseHooked) return;
        _mouseHooked = true;
        try { _realOut.write(mouseButtons.disableBytes()); } catch { /* terminal already gone */ }
      };
      process.once('exit', offMouse);
      process.once('SIGINT', offMouse);
      process.once('SIGTERM', offMouse);
    }
  } catch { /* cosmetic — never block the TUI on mouse setup */ }

  const app = render(React.createElement(App, { options }), {
    stdout: _tuiStdout,
    stdin: process.stdin,
    // We handle Ctrl+C ourselves (cancel current turn vs. exit) inside <App/>.
    exitOnCtrlC: false,
  });

  // Expose the instance so components can yield the terminal to interactive
  // command handlers (clear the live frame) and reclaim it afterwards.
  inkRuntime.setApp(app);
  // Register the EXACT stdout object ink keyed its instance WeakMap by. Because
  // we hand render() the _tuiStdout Proxy (scrollbackPreserve), a lookup by the
  // bare process.stdout would miss and getInkInstance() would return null —
  // silently disabling the resize full-repaint fix (residual「残线」on zoom).
  inkRuntime.setRenderStdout(_tuiStdout);

  await app.waitUntilExit();

  // A stream wrapper may split an ANSI token across writes. Do not strand the
  // final incomplete suffix when Ink exits before another frame completes it.
  try {
    const _pendingClearBytes = _clearNormalizer.flush();
    if (_pendingClearBytes) _realOut.write(_pendingClearBytes);
  } catch { /* terminal already gone */ }

  // Ink has released the terminal — clear the active-surface flag so any later
  // classic-mode work in this process can use inquirer normally again.
  delete process.env.KHY_INK_TUI_ACTIVE;

  // Tear down the pinned topic bar (块3): restore the terminal window title
  // (it is OSC-based, not a DECSTBM scroll region — see runtime/topicBar.js). The mount
  // effect's cleanup and the process exit hook also call this; disable() is
  // idempotent, so a final explicit call here covers a clean waitUntilExit return.
  try { require('./runtime/topicBar').disable(); } catch { /* terminal already gone */ }
  // Same for the right rail: blank the reserved gutter so no board fragment
  // outlives the session (the module's own exit hook covers hard exits).
  try { require('./runtime/sidebarRail').disable(); } catch { /* terminal already gone */ }
  // Same for mouse tracking: leave the terminal out of tracking mode so the next
  // command can wheel-scroll and click-to-select again. Written UNCONDITIONALLY,
  // not behind mouseButtonsEnabled() — gating it means a session that ran with the
  // gate on, then had the env flipped off mid-life (or an older build that enabled
  // a mode this build no longer knows about) walks away leaving the terminal broken.
  try {
    const _mouseButtons = require('./mouseButtons');
    _realOut.write(_mouseButtons.disableBytes());
  } catch { /* terminal already gone */ }

  // Print the resume hint now that ink has released the terminal. Without this
  // the TUI exits silently after Ctrl-C and the user never learns the session
  // is recoverable — the classic REPL prints this on exit but the ink path
  // skipped it (the「ctrl c 后没有 resume」report). The transcript is already
  // persisted per turn (Store B / JSONL); this only surfaces how to restore it.
  printInkResumeHint();
}

/**
 * Surface the resume affordance after the ink TUI tears down. Best-effort and
 * never throws — it runs on the exit path. Mirrors the classic REPL's
 * printResumeRecoveryHints: prefer the live JSONL session id, fall back to the
 * most-recent persisted conversation.
 */
function printInkResumeHint() {
  if (printInkResumeHint._done) return; // once across both exit paths
  printInkResumeHint._done = true;
  try {
    const ai = require('../ai');
    // Ensure a final snapshot exists (legacy summary store); the full transcript
    // is auto-saved per turn, so this is belt-and-suspenders, not load-bearing.
    try { ai.saveConversation(); } catch { /* non-critical */ }

    const chalk = require('chalk');
    const dim = (s) => (chalk && chalk.dim ? chalk.dim(s) : s);
    const cyan = (s) => (chalk && chalk.cyan ? chalk.cyan(s) : s);

    let liveId = '';
    try { liveId = (ai.getLiveSessionId && ai.getLiveSessionId()) || ''; } catch { /* ignore */ }
    if (!liveId) {
      try { liveId = String(ai.listConversations()[0]?.sessionId || ''); } catch { /* ignore */ }
    }
    if (!liveId) return; // nothing persisted yet — no hint to give

    // 提示文案/着色由 resumeHint 叶子供给,与经典 REPL(printResumeRecoveryHints)共用
    // 同一份 SSOT——改一处两入口同步,不再各自内联。
    const { buildResumeHintLines, renderResumeHintLines } = require('../resumeHint');
    console.log('');
    for (const line of renderResumeHintLines(buildResumeHintLines({ liveId }), { dim, cyan })) {
      console.log(line);
    }
    console.log('');
  } catch { /* exit path — never block on a hint */ }
}

module.exports = { startInkApp, printInkResumeHint };
