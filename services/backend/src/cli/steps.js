/**
 * Step / Process Tracking — extracted from aiRenderer.js
 *
 * Contains: startSparkle, printStepLine, printStepDetail,
 *           ProcessTracker, printCompactingNotice,
 *           printProcessStep, printToolCall, printActionHint, printThinkingStep
 */
const {
  c, THEME, isInteractiveInputActive,
  SPINNER_FRAMES, SPINNER_ACTIVE_CHAR, REDUCED_MOTION_DOT,
  PHASE_LABELS, _formatElapsed,
  DOT_INDICATOR, DOT_SUCCESS, DOT_ERROR, DOT_DONE, DOT_PENDING,
  TREE_LAST, TREE_MID,
  getToolDisplayName, getToolFamilyIcon,
} = require('./renderTheme');
const { displayWidth, truncateToWidth } = require('./formatters');
const { ccFormatDurationOr } = require('./ccFormat');

let _sparkleTimers = new Set();

/**
 * Start an animated spinner for tool call in-progress display.
 * Uses a blinking solid dot to match Claude Code active step indicator.
 *
 * @param {string} label - tool display name (e.g. "Bash", "Read")
 * @param {string} target - parameter string
 * @param {string} detail - extra detail
 * @returns {{ stop: Function }}
 */
function startSparkle(label, target = '', detail = '') {
  if (!process.stdout.isTTY) return { stop() {} };
  // When TUI (InlineRenderer) is active, skip direct stdout writes —
  // the TUI handles all rendering through its own render loop.
  if (process.stdout.isTTY) return { stop() {} };

  let frame = 0;
  const startTime = Date.now();
  const ELAPSED_SHOW_THRESHOLD = 2; // show elapsed after 2s (Qwen Code style)
  const ELAPSED_WARN_THRESHOLD = 8; // shift to red after 8s

  const timer = setInterval(() => {
    if (isInteractiveInputActive()) return;
    if (process.stdin.isRaw) return;
    frame++;
    const blinkDim = frame % 2 === 0;
    const elapsed = (Date.now() - startTime) / 1000;

    // Color: normal -> red after 8s (gradual shift)
    let charColor;
    if (elapsed > ELAPSED_WARN_THRESHOLD) {
      const t = Math.min(1, (elapsed - ELAPSED_WARN_THRESHOLD) / 12);
      const r = Math.round(169 + (255 - 169) * t);
      const g = Math.round(169 + (107 - 169) * t);
      const b = Math.round(169 + (128 - 169) * t);
      charColor = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    } else {
      charColor = THEME.text;
    }
    const icon = blinkDim
      ? c().hex(charColor).dim(DOT_INDICATOR)
      : c().hex(charColor)(DOT_INDICATOR);
    const targetStr = target ? c().dim(`(${target})`) : '';
    const detailStr = detail ? c().dim(` ${detail}`) : '';

    // Elapsed time display (Qwen Code: >2s show, DeepSeek: "running (5s)")
    let elapsedStr = '';
    if (elapsed >= ELAPSED_SHOW_THRESHOLD) {
      const secs = Math.floor(elapsed);
      const elapsedText = _formatElapsed(secs);
      if (elapsed > ELAPSED_WARN_THRESHOLD) {
        elapsedStr = ` ${c().hex(THEME.error)(elapsedText)}`;
      } else {
        elapsedStr = ` ${c().dim(elapsedText)}`;
      }
    }

    const line = `  ${icon} ${c().bold(label)} ${targetStr}${detailStr}${elapsedStr}`;
    let _sw;
    try { _sw = require('./syncOutput').syncWrite; } catch { /* ignore */ }
    if (typeof _sw !== 'function') _sw = (fn) => fn();
    _sw(() => process.stdout.write(`\r\x1b[K${line}`));
  }, 120); // 120ms = ~8fps matching Claude Code

  _sparkleTimers.add(timer);

  return {
    stop() {
      clearInterval(timer);
      _sparkleTimers.delete(timer);
      if (!isInteractiveInputActive()) {
        process.stdout.write('\r\x1b[K');
      }
    },
  };
}

/**
 * Print a single process step line (Claude Code style).
 * @param {'pending'|'active'|'success'|'error'|'done'} status
 * @param {string} label - e.g. "Read", "Bash", "Write", "Search", "Update"
 * @param {string} [target] - e.g. "src/cli/repl.js", "node -c ..."
 * @param {string} [detail] - e.g. "(ctrl+o to expand)", "-> OK"
 */
function printStepLine(status, label, target = '', detail = '') {
  if (process.stdout.isTTY) return;
  let dot;
  switch (status) {
    case 'active':  dot = c().hex(THEME.text)(DOT_INDICATOR); break;
    case 'success': dot = c().hex(THEME.success)(DOT_SUCCESS); break;
    case 'error':   dot = c().hex(THEME.error)(DOT_ERROR); break;
    case 'done':    dot = c().dim(DOT_DONE); break;
    default:        dot = c().dim(DOT_PENDING); break;
  }

  const targetStr = target ? c().dim(`(${target})`) : '';
  const detailStr = detail ? ` ${detail}` : '';
  const labelColor = status === 'success' ? c().hex(THEME.success)(label)
                   : status === 'error'   ? c().hex(THEME.error)(label)
                   : status === 'active'  ? c().hex(THEME.text).bold(label)
                   : c().dim(label);

  console.log(`  ${dot} ${labelColor} ${targetStr}${detailStr}`);
}

/**
 * Print an indented detail line with tree branch character.
 * @param {string} text - detail text
 * @param {boolean} [isLast=true] - whether this is the last detail line
 */
function printStepDetail(text, isLast = true) {
  if (process.stdout.isTTY) return;
  // Claude Code style: ⎿ prefix for result detail lines
  const branch = isLast ? TREE_LAST : TREE_MID;
  console.log(`  ${c().dim(branch)}  ${text}`);
}

/**
 * ProcessTracker — manages a sequence of process steps with live updates.
 *
 * Usage:
 *   const tracker = new ProcessTracker();
 *   tracker.start('Reading', 'src/cli/repl.js', '1 file...');
 *   // ... do work ...
 *   tracker.complete('Read 245 lines');
 *   tracker.start('Write', 'src/cli/ai.js');
 *   // ... do work ...
 *   tracker.complete('Added 3 lines');
 */
class ProcessTracker {
  constructor() {
    this._current = null;
    this._startTime = null;
    this._sparkle = null;
  }

  /**
   * Start a new step. Completes any previous in-progress step first.
   * @param {string} label - e.g. "Reading", "Write", "Bash", "AI thinking"
   * @param {string} [target] - e.g. file path, command, etc.
   * @param {string} [hint] - e.g. "1 file...", "ctrl+o to expand"
   */
  start(label, target = '', hint = '') {
    // Auto-complete previous step if still active
    if (this._current) {
      this._finishCurrent('done');
    }
    this._current = { label, target, hint };
    this._startTime = Date.now();

    // Print the initial static line, then overlay sparkle animation
    printStepLine('active', label, target, hint);
    this._sparkle = startSparkle(label, target, hint);

    // Sync to HUD
    try { require('./hudRenderer').toolStart(label, target); } catch {}
  }

  /**
   * Complete the current step — shows gray dot (finished, no longer active).
   * @param {string} [detail] - completion detail shown on tree line
   */
  complete(detail = '') {
    this._finishCurrent('done', detail);
  }

  /**
   * Mark the current step as failed.
   * @param {string} [detail] - error detail shown on tree line
   */
  fail(detail = '') {
    this._finishCurrent('error', detail);
  }

  /**
   * Internal: overwrite current active line with final status + detail.
   */
  _finishCurrent(status, detail = '') {
    if (!this._current) return;
    // In TUI mode, stop sparkle but skip all stdout writes
    if (process.stdout.isTTY) {
      if (this._sparkle) { this._sparkle.stop(); this._sparkle = null; }
      try { require('./hudRenderer').toolEnd(this._current.label, status, Date.now() - this._startTime); } catch {}
      this._current = null;
      this._startTime = null;
      return;
    }

    // Stop sparkle animation
    if (this._sparkle) {
      this._sparkle.stop();
      this._sparkle = null;
    }

    const elapsed = Date.now() - this._startTime;
    const elapsedStr = elapsed > 1000 ? ` (${ccFormatDurationOr(elapsed, `${(elapsed / 1000).toFixed(1)}s`, process.env)})` : '';

    // Sync to HUD
    try { require('./hudRenderer').toolEnd(this._current.label, status, elapsed); } catch {}

    if (process.stdout.isTTY && !isInteractiveInputActive()) {
      let _sw;
      try { _sw = require('./syncOutput').syncWrite; } catch { /* ignore */ }
    if (typeof _sw !== 'function') _sw = (fn) => fn();
      _sw(() => {
        process.stdout.write('\x1b[1A\r\x1b[K');
        const { label, target } = this._current;
        printStepLine(status, label, target, elapsedStr);
      });
    } else if (process.stdout.isTTY) {
      // Keep output stable while user is typing a busy-time interjection.
      const { label, target } = this._current;
      printStepLine(status, label, target, elapsedStr);
    }
    // On non-TTY, skip rewrite — the active line stays as-is (no double output)

    if (detail) {
      printStepDetail(detail);
    }

    this._current = null;
    this._startTime = null;
  }

  /**
   * Whether a step is currently in progress.
   */
  get isActive() {
    return this._current !== null;
  }
}

// ── Context Compaction Notice ──────────────────────────────────────────

/**
 * Print a "Compacting conversation..." notice (Claude Code style).
 * @param {object} opts - { elapsed, tokens, thought }
 */
function printCompactingNotice(opts = {}) {
  if (process.stdout.isTTY) return;
  const parts = [];
  if (opts.elapsed) parts.push(opts.elapsed);
  if (opts.tokens)  parts.push(`\u2191 ${opts.tokens} tokens`);
  if (opts.thought) parts.push(`thought for ${opts.thought}`);

  const meta = parts.length > 0 ? c().dim(` (${parts.join(' \u00B7 ')})`) : '';
  // Claude Code style: ✻ Conversation compacted
  console.log(`  ${c().hex(THEME.warning)('\u273B')} ${c().hex(THEME.warning).bold('Conversation compacted')}${meta}`);

  if (opts.tip) {
    printStepDetail(`Tip: ${opts.tip}`);
  }
}

// ── Legacy helpers (preserved for backward compatibility) ──────────────

function printProcessStep(icon, message, detail = '') {
  if (process.stdout.isTTY) return;
  const detailStr = detail ? c().dim(` (${detail})`) : '';
  console.log(`  ${icon} ${c().white(message)}${detailStr}`);
}

function printToolCall(toolName, args = '') {
  if (process.stdout.isTTY) return;
  const displayName = getToolDisplayName(toolName);
  const icon = getToolFamilyIcon(toolName);
  const targetStr = args ? c().dim(`(${args})`) : '';
  console.log(`  ${c().hex(THEME.text)(icon)} ${c().hex(THEME.text).bold(displayName)} ${targetStr}`);
}

/**
 * Print a brief description line before an action (Claude Code style).
 * Shows a dim one-liner explaining what will be done next.
 * @param {string} description - e.g. "Updating the spinner icon to use ..."
 */
function printActionHint(description) {
  if (process.stdout.isTTY) return;
  console.log(c().dim(`  ${description}`));
}

function printThinkingStep(thought) {
  if (process.stdout.isTTY) return;
  const truncated = thought.length > 80 ? thought.slice(0, 80) + '...' : thought;
  console.log(`  ${c().dim(DOT_DONE)} ${c().dim(truncated)}`);
}

module.exports = {
  startSparkle,
  printStepLine,
  printStepDetail,
  ProcessTracker,
  printCompactingNotice,
  printProcessStep,
  printToolCall,
  printActionHint,
  printThinkingStep,
};
