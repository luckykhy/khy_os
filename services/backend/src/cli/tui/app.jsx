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
  // Ensure JSX requires work and the ink namespace is resolved before mount.
  inkRuntime.registerJsx();
  const { render } = await inkRuntime.loadInk();

  // App is a .jsx component; require AFTER registerJsx() so babel transpiles it.
  const App = require('./ink-components/App');

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
  // we hand to ink in a Proxy that normalizes ink's clearTerminal frame per-platform:
  // on non-win32 it strips the `\x1b[3J` (clear-scrollback) escape while passing
  // `\x1b[2J`/`\x1b[H` through; on win32 it INJECTS `\x1b[3J` into ink's `\x1b[2J\x1b[0f`
  // (→ `\x1b[2J\x1b[3J\x1b[0f`) because Windows conhost/Windows Terminal scrolls the old
  // frame INTO scrollback on `\x1b[2J` instead of erasing in place — without the `3J`,
  // every fullscreen repaint stacks another full copy of the transcript (the「同一对话
  // 窗口重复显示 2–3 份」bug). ink emits `clearTerminal + fullStaticOutput + output` as a
  // single write() when the live region height >= rows (ink.js:327 / instance.js:132);
  // non-win32 clearTerminal is `\x1b[2J\x1b[3J\x1b[H` and the `3J` wipes native scrollback
  // — which is exactly why long output「滚不到中间」on those terminals. We only override
  // write(); every other property (columns/rows/isTTY/on('resize')/syncOutput backing)
  // is delegated to the real process.stdout so ink's sizing/resize/sync semantics are
  // unchanged. Not touching process.stdout itself means no teardown is required and
  // non-ink bare writes (topicBar OSC title, etc.) are unaffected. Gate off →
  // normalizeClearTerminal is a byte-identical passthrough → behaves like today.
  const scrollbackPreserve = require('./scrollbackPreserve');
  const _realOut = process.stdout;
  const _tuiStdout = new Proxy(_realOut, {
    get(target, prop) {
      if (prop === 'write') {
        return function (chunk, ...rest) {
          return target.write(
            scrollbackPreserve.normalizeClearTerminal(chunk, process.env, process.platform),
            ...rest,
          );
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v; // bind back to real stdout — avoid `this` drift
    },
  });

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

  // Ink has released the terminal — clear the active-surface flag so any later
  // classic-mode work in this process can use inquirer normally again.
  delete process.env.KHY_INK_TUI_ACTIVE;

  // Tear down the pinned topic bar (块3): restore the full-screen scroll region
  // and clear row 1 so the shell prompt returns to a normal terminal. The mount
  // effect's cleanup and the process exit hook also call this; disable() is
  // idempotent, so a final explicit call here covers a clean waitUntilExit return.
  try { require('./runtime/topicBar').disable(); } catch { /* terminal already gone */ }

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
