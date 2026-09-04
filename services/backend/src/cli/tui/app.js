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

  // Session hang watchdog (KHY_SESSION_WATCHDOG, default on): async hangs and
  // sync stalls on the interactive surface become observable (honest log +
  // diagnostics + onHang hook). It never kills — governance Rule 3. Fail-soft
  // by design and idempotent per process (safe across TUI retry/fallback).
  try {
    require('../../services/sessionWatchdog').installSessionWatchdog({
      env: process.env,
      logger: console,
    });
  } catch { /* watchdog optional — never blocks TUI startup */ }

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
  // we hand to ink in a Proxy that normalizes ink's clearTerminal frame. **两步归一化**:
  // 两类终端都先**剥离** 3J(清回滚缓冲);win32 再把剩下的 ED2 清屏改写成「归位 + ED0」。
  // 历史上 win32 分支曾反向**注入** 3J 去压制重复帧,已刻意移除 —— 注入会直接清空用户
  // 正在查看的原生 scrollback,代价高于它修的症状。现在 win32 走第三条路:把 clearTerminal
  // 从 ED2 形式(2J + 0f)**改写**为等价的「归位 + ED0」(H + J)。conhost / Windows Terminal
  // 的 ED2 语义是「把视口整屏滚进 scrollback 再填白」而非就地擦除,所以每触发一次全屏重绘,
  // 回滚里就永久多出一份完整的 banner+输入框副本 —— 这正是用户报「UI 显示混乱」的直接成因。
  // ED0 就地擦除既不滚屏(不留副本)也不动 scrollback(历史仍可上翻),两个目标同时成立。
  // 本层与「从源头少触发」的三层预算(liveRegionBudget / liveHeightClamp / overlayLiveBudget)
  // 正交叠加:那层管少触发,本层保证即便触发也不留副本 —— 其中 KHY_SUPPRESS_STATIC_REPRINT
  // (第三层,getStaticSnapshot 注入 ink 实例的 fullStaticOutput)更进一步把 fullscreen 帧
  // `clearTerminal + fullStaticOutput + output` 里冗余的整段转录重发剥掉:static 内容早已
  // 增量写进终端,重写超过视口高度必然滚屏,把重印头部推进 scrollback 形成第二/三份完整副本
  // (用户报「启动后历史重复几次」的直接成因)。KHY_FULLSCREEN_TAILCUT(第四层,getRows 注入
  // 视口行数)再把已验证帧的活动区 output 尾切到 rows-1 行 —— live 区触顶时重印超高 output
  // 的头部行必然滚出视口(印了也看不见),却会在 scrollback 逐帧堆叠副本(用户报「对话中重复
  // 渲染多次」的直接成因),尾切后整帧不滚屏、可见终态逐字节等价。校验失败/实例缺失 → 逐字节
  // 回退今日行为。
  // ink emits `clearTerminal + fullStaticOutput + output` as a
  // single write() when the live region height >= rows (ink.js:327 / instance.js:132);
  // non-win32 clearTerminal is `[2J[3J[H` and the `3J` wipes native scrollback
  // — which is exactly why long output「滚不到中间」on those terminals; win32 的 clearTerminal
  // 本就无 3J 可剥,故改走上述 ED0 就地擦除改写。We only override
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
    process.platform,
    {
      // 第三层(全屏帧整段转录重发抑制)的校验源:ink 实例的 fullStaticOutput。
      // render() 的同步首帧不可能命中 fullscreen 分支(lastOutputHeight 从 0 起步),
      // 而 inkRuntime.setApp/setRenderStdout 紧跟 render() 之后注册 —— 真正能触发
      // fullscreen 分支的帧到来时实例必已注册。
      // 关键修复:实例未注册/fullStaticOutput 不可用时返回 '' 而非 null —— 空串是合法快照
      // (会话尚无 static),校验平凡成立,第四层尾切照常生效;若返回 null 则整层跳过,
      // win32 ED2 清屏会把旧视口滚进 scrollback 形成重复帧(用户报「启动时重复两次」)。
      getStaticSnapshot: () => {
        try {
          const inst = inkRuntime.getInkInstance();
          return inst && typeof inst.fullStaticOutput === 'string' ? inst.fullStaticOutput : '';
        } catch {
          return '';
        }
      },
      // 第四层(全屏帧活区尾切)的视口几何源:live 区高度 ≥ rows 时,ED0 就地擦除后
      // 重印超高 output 仍会把帧的头/尾行滚进 scrollback 逐帧堆叠(重复渲染根因)。
      // 注入真实视口行/列数 + 显示宽度函数(与 liveHeightClamp 同一 formatters.displayWidth
      // 单源,CJK/emoji 感知、已剥 ANSI),叶子把已验证帧的 output 尾切到 rows-1 个视觉行
      // 保证不滚屏;rows 取不到(部分 Windows 终端报 0)→ 叶子侧不切,逐字节回退。
      getRows: () => process.stdout.rows,
      getColumns: () => process.stdout.columns,
      measureWidth: (s) => require('../../formatters').displayWidth(s),
    }
  );
  const _tuiStdout = new Proxy(_realOut, {
    get(target, prop) {
      if (prop === 'write') {
        return function (chunk, ...rest) {
          const normalized = _clearNormalizer.write(chunk);
          const frame = typeof normalized === 'string' ? normalized : String(normalized || '');
          // 注意末项 ED0:win32 的 clearTerminal 已被 scrollbackPreserve 改写成 `\x1b[H\x1b[J`,
          // 若只匹配 2J/3J,全屏重绘时右栏不会重画 → 看板留残影。
          const forceRailPaint = /\n|\r|\x1b\[2J|\x1b\[3J|\x1b\[J/.test(frame);
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
