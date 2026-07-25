'use strict';

/**
 * topicBar — shows the CURRENT conversation topic in the terminal's WINDOW TITLE
 * (the emulator's title bar / tab label), driven by raw ANSI OSC sequences.
 *
 * Why the window title and not a pinned row: a DECSTBM scroll region (the earlier
 * approach) is fundamentally incompatible with Ink. Ink erases its previous frame
 * by counting LOGICAL lines and moving the cursor up relative to where it left it
 * — it has no concept of a reserved row. Once streaming output scrolls the
 * region, Ink's recorded frame origin desyncs and it erases the wrong lines,
 * leaving a duplicated prompt/footer frame behind. The OS window title is fully
 * OUT OF BAND: OSC 0 (`\x1b]0;TITLE\x07`) sets the title without touching the
 * scroll region, the cursor, or any cell Ink manages — zero render conflict.
 *
 * No alternate screen, no scroll region. On disable we clear our title; the
 * shell's own PROMPT_COMMAND restores its host:path title on the next prompt.
 *
 * Capability-gated to TTYs (a piped/redirected stdout has no title bar). Honors
 * KHY_NO_TOPIC_BAR as an explicit off switch; otherwise on by default. Terminals
 * that don't render a title (e.g. bare tmux without title passthrough) simply
 * ignore the OSC — callers may set KHY_NO_TOPIC_BAR to get the FooterBar topic
 * line instead (App passes the topic to FooterBar when enable() returns false).
 */

// ── ANSI sequences ──────────────────────────────────────────────────────────
const OSC = '\x1b]';   // Operating System Command introducer
const BEL = '\x07';    // string terminator (most compatible across emulators)

// Working indicator: the glyph LEFT of the topic. Idle → static ✱ ("太阳"); while
// khy is busy → a left-right bouncing dot. Pure-leaf decides the prefix per frame;
// this module owns only the timer that advances the frame and repaints. Gated
// (KHY_TOPIC_BAR_WORKING_DOT, default-on) — off → prefix stays ✱, timer never runs.
const _workingIndicator = require('./topicBarWorkingIndicator');

let _state = {
  enabled: false,
  title: '',
  stdout: null,
  working: false,
  tick: 0,
};

// setInterval handle for the bouncing-dot animation (null when idle/off).
let _animTimer = null;
// Animation cadence (ms). ~180ms reads as a smooth left-right motion without
// flooding the terminal with title writes.
const _ANIM_MS = 180;

// Process-level safety net: clear our title on hard exit / signal so a lingering
// "✱ topic" does not outlive the session before the shell repaints its prompt.
let _exitHooked = false;
function _installExitHook() {
  if (_exitHooked) return;
  _exitHooked = true;
  const off = () => { try { disable(); } catch { /* terminal already gone */ } };
  process.once('exit', off);
  process.once('SIGINT', off);
  process.once('SIGTERM', off);
}

function _resolveStdout(stdout) {
  return stdout || process.stdout;
}

// Window titles are plain text (no SGR). Keep a generous cap so an unusually long
// topic does not bloat the title; emulators truncate visually anyway.
function _clamp(text) {
  const s = String(text || '');
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}

// Write the OSC 0 title. Empty topic clears the title (used on disable).
function _paint() {
  if (!_state.enabled || !_state.stdout) return;
  const t = _clamp(_state.title);
  // Leaf decides the left glyph: static ✱ when idle/off, bouncing dot when working.
  // Any leaf failure falls back to the historical `✱ ` prefix (byte-identical).
  let prefix = '✱ ';
  try {
    prefix = _workingIndicator.titlePrefix({ working: _state.working, tick: _state.tick }, process.env);
  } catch { /* keep static ✱ fallback */ }
  const title = t ? `${prefix}${t}` : '';
  try { _state.stdout.write(`${OSC}0;${title}${BEL}`); } catch { /* terminal gone */ }
}

// Stop the bouncing-dot animation (if running) and reset the frame counter.
function _stopAnim() {
  if (_animTimer) {
    try { clearInterval(_animTimer); } catch { /* already cleared */ }
    _animTimer = null;
  }
  _state.tick = 0;
}

/**
 * Enable the window-title topic display. Returns true when active (caller then
 * suppresses the FooterBar topic line); false when the caller should fall back to
 * the in-tree FooterBar display. Idempotent.
 */
function enable(stdout) {
  if (_state.enabled) return true;
  if (process.env.KHY_NO_TOPIC_BAR) return false;
  const out = _resolveStdout(stdout);
  // A non-TTY stdout (pipe/redirect) has no title bar to set.
  let isTTY = !!(out && out.isTTY);
  if (!isTTY) {
    try { isTTY = !!require('./terminalCapabilities').detectCapabilities(out).isTTY; } catch { /* keep */ }
  }
  if (!isTTY) return false;
  _state = { enabled: true, title: _state.title, stdout: out, working: _state.working, tick: 0 };
  _installExitHook();
  _paint();
  return true;
}

function isEnabled() {
  return _state.enabled;
}

/** Update the displayed topic (no-op when disabled or unchanged). */
function setTitle(text) {
  const next = String(text || '');
  if (_state.title === next && _state.enabled) return;
  _state.title = next;
  if (_state.enabled) _paint();
}

/**
 * Toggle the "khy is working" animation on the title glyph. While working, a
 * timer advances the bouncing-dot frame and repaints the title; when idle, the
 * glyph returns to the static ✱. No-op when disabled, when the working flag is
 * unchanged, or when the indicator is gated off (KHY_TOPIC_BAR_WORKING_DOT=0) —
 * in which case the timer never starts and the title stays byte-identical to the
 * historical static `✱ topic`.
 *
 * @param {boolean} working
 */
function setWorking(working) {
  const next = !!working;
  if (_state.working === next) return;
  _state.working = next;
  if (!_state.enabled) return;
  let gateOn = true;
  try { gateOn = _workingIndicator.isEnabled(process.env); } catch { gateOn = true; }
  if (next && gateOn) {
    // Start the bounce animation: advance the frame each tick and repaint. unref()
    // so a lingering timer never keeps the process alive on exit.
    _stopAnim();
    _state.tick = 0;
    _paint();
    try {
      _animTimer = setInterval(() => {
        _state.tick += 1;
        _paint();
      }, _ANIM_MS);
      if (_animTimer && typeof _animTimer.unref === 'function') _animTimer.unref();
    } catch { _animTimer = null; }
  } else {
    // Stopped working (or gated off) → drop back to the static ✱ glyph.
    _stopAnim();
    _paint();
  }
}

/**
 * Resize hook — kept for API compatibility. The window title is independent of
 * terminal dimensions, so there is nothing to recompute; we simply repaint in
 * case the emulator dropped the title across a reflow.
 */
function onResize() {
  if (_state.enabled) _paint();
}

/**
 * Suspend — kept for API compatibility with the App's interactive-command flow.
 * Unlike the old scroll-region implementation there is no terminal real estate to
 * relinquish (the title bar is the emulator's, not part of the scroll area), so
 * the topic title is simply left in place. No-op beyond a state guard.
 */
function suspend() {
  // Intentionally a no-op: the OSC title never overlaps an interactive prompt.
}

/** Resume — counterpart to suspend(); repaint in case anything cleared the title. */
function resume() {
  if (_state.enabled) { _paint(); return true; }
  return false;
}

/**
 * Fully tear down: clear our title. The shell's PROMPT_COMMAND restores its own
 * host:path title on the next prompt. Idempotent.
 */
function disable() {
  _stopAnim();
  _state.working = false;
  if (!_state.stdout) { _state.enabled = false; return; }
  const out = _state.stdout;
  _state.enabled = false;
  try { out.write(`${OSC}0;${BEL}`); } catch { /* terminal already gone */ }
}

module.exports = { enable, isEnabled, setTitle, setWorking, onResize, suspend, resume, disable };
