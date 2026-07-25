/**
 * DynamicSpinner — Claude Code-style animated spinner with token/effort display.
 * Extracted from aiRenderer.js for modularity.
 */
const {
  c, THEME, isInteractiveInputActive,
  SPINNER_ACTIVE_CHAR, THINKING_VERBS, PHASE_LABELS,
  _formatElapsed,
} = require('./renderTheme');
const { displayWidth, truncateToWidth } = require('./formatters');
const {
  SHIMMER_INTERVAL_MS,
  spinnerShimmerEnabled,
  computeGlimmerIndex,
  computeShimmerSegments,
} = require('./spinnerShimmer');

class DynamicSpinner {
  constructor() {
    this._frame = 0;
    this._timer = null;
    this._phase = 'init';
    this._detail = '';
    this._startTime = Date.now();
    this._phaseStartTime = Date.now();
    this._inputTokens = 0;   // ↑ tokens sent
    this._outputTokens = 0;  // ↓ tokens received
    this._effort = '';        // 'low' | 'medium' | 'high' | ''
    this._blinkState = true;
    this._verbIndex = 0;
    this._verbRotateAt = 0;  // frame count when we last rotated verb
    this._tipShown = false;
    this._lastTokenAt = Date.now(); // Track last token arrival for stall detection
    this._promptShown = false;
    this._promptLines = 0;
    this._promptMode = 'plain'; // 'none' | 'plain' | 'framed'
    this._promptRuleColor = THEME.claude;
    this._promptFooter = '';
    // Keep cursor on the interjection input line while spinner updates above.
    this._spinnerOffsetFromPrompt = 0;
    this._promptCursorAnchored = false;
    this._wasInteractiveLastFrame = false;
  }

  start(phase = 'init') {
    if (this._timer) this.stop();
    this._phase = phase;
    this._detail = ''; // reset stale detail from previous setPhase
    this._phaseStartTime = Date.now();
    if (!this._startTime || phase === 'request') this._startTime = Date.now();
    this._lastTokenAt = Date.now();
    this._timer = setInterval(() => this._render(), 120); // ~8fps matching Claude Code
  }

  setPhase(phase, detail = '') {
    this._phase = phase;
    this._detail = detail;
    this._phaseStartTime = Date.now();
  }

  /**
   * Reset the elapsed timer to now. Call this when the first SSE event
   * arrives so the displayed time reflects actual processing, not TTFB.
   */
  resetTimer() {
    this._startTime = Date.now();
    this._lastTokenAt = Date.now();
  }

  setTokens(count, direction = 'output') {
    if (direction === 'input') {
      this._inputTokens = count;
    } else {
      this._outputTokens = count;
      this._lastTokenAt = Date.now(); // Reset stall timer on new tokens
    }
  }

  setEffort(level) {
    this._effort = level || '';
  }

  /**
   * Configure how interjection prompt is rendered while spinner is active.
   * @param {'none'|'plain'|'framed'} mode
   * @param {{ruleColor?: string, footer?: string}} [opts]
   */
  setPromptMode(mode = 'plain', opts = {}) {
    if (mode === 'none') this._promptMode = 'none';
    else this._promptMode = (mode === 'framed') ? 'framed' : 'plain';
    this._promptRuleColor = String(opts.ruleColor || THEME.claude);
    this._promptFooter = String(opts.footer || '');
  }

  _getThinkingVerb() {
    // Rotate through creative verbs every ~8 seconds (67 frames at 120ms)
    if (this._frame - this._verbRotateAt >= 67) {
      this._verbIndex = (this._verbIndex + 1) % THINKING_VERBS.length;
      this._verbRotateAt = this._frame;
    }
    return THINKING_VERBS[this._verbIndex];
  }

  _render() {
    if (!process.stdout.isTTY) return;
    // When the Ink TUI owns the screen, skip direct stdout writes — Ink renders
    // progress through its own loop and our writes would corrupt its frame.
    // NOTE: the original guard here was `if (process.stdout.isTTY) return;`,
    // which is always true on a TTY — it silently killed the classic-mode
    // spinner since the 0.1.88 Ink migration, so legacy Windows conhost (no Ink)
    // showed NO progress at all during a turn and looked frozen. Gate on the
    // actual Ink-active flag instead.
    if (process.env.KHY_INK_TUI_ACTIVE === '1') return;
    if (isInteractiveInputActive()) {
      this._wasInteractiveLastFrame = true;
      return;
    }
    // Keep spinner visible even when readline uses raw mode.
    // Some terminals keep stdin in raw while waiting for model replies;
    // hard-blocking here makes users think the process is stalled.
    const blockInRawMode = String(process.env.KHY_SPINNER_BLOCK_IN_RAW_MODE || 'false').toLowerCase() === 'true';
    if (process.stdin.isRaw && blockInRawMode) return;

    let _sync;
    try { _sync = require('./syncOutput'); } catch { _sync = null; }
    if (_sync) _sync.beginSync();
    try {
      // When typing guard just expired, clear the interject prompt remnant
      // before painting the spinner to prevent a single-frame flash of both
      if (this._wasInteractiveLastFrame) {
        this._wasInteractiveLastFrame = false;
        process.stdout.write('\x1b[2K\x1b[1G');
      }
      this._renderInner();
    } finally {
      if (_sync) _sync.endSync();
    }
  }

  _renderInner() {

    this._blinkState = !this._blinkState;
    this._frame++;

    const elapsedSec = (Date.now() - this._startTime) / 1000;
    const elapsedStr = _formatElapsed(elapsedSec);

    // Determine label — rotate verbs for thinking/request phases;
    // for tool phases, prefer tool-specific Chinese label (G7)
    let label;
    if (this._phase === 'thinking' || this._phase === 'request') {
      label = this._getThinkingVerb();
    } else if (this._detail && PHASE_LABELS[`tool:${this._detail.toLowerCase().replace(/[\s_-]/g, '')}`]) {
      label = PHASE_LABELS[`tool:${this._detail.toLowerCase().replace(/[\s_-]/g, '')}`];
    } else {
      label = PHASE_LABELS[this._phase] || this._phase;
    }

    const detailRaw = this._detail ? ` ${this._detail}` : '';
    // Width-aware, surrogate-safe cap: a raw .slice can split an emoji's
    // surrogate pair (rendering �) and .length under-counts CJK width, so a
    // Chinese tool path/name would over-run. truncateToWidth walks by code
    // point and appends its own ellipsis.
    const detail = displayWidth(detailRaw) > 120
      ? ` ${truncateToWidth(this._detail, 119)}`
      : detailRaw;

    // Build status parts: (Xm Ys · ↑ 10.3k tokens · thinking with high effort)
    // The timer + token byline is revealed only after 30s (CC
    // SHOW_TOKENS_AFTER_MS) so a fast turn shows just the verb; the effort
    // suffix is not gated. Logic in cli/spinnerMeta.js. Gate
    // KHY_SPINNER_META_GATE off → legacy (timer + tokens from frame 1).
    // Token byline 数字格式走 ccFormatNumber SSOT(对齐 CC
    // SpinnerAnimationRow.tsx:178 `const tokenCount = formatNumber(totalTokens)`):
    // 紧凑记数、百万级进 "m" 单位,且**保留尾随 ".0"**(CC `formatNumber` 对 n≥1000
    // 钉 minimumFractionDigits:1)→ 8000→"8.0k"、45000→"45.0k"、1000000→"1.0m"。
    // 刀41:此前误用 ccFormatTokens(= formatNumber 去 ".0",显 "8k"/"45k"/"1m"),
    // 与 CC formatNumber 及本文件 legacy 回退(`(n/1000).toFixed(1)k` 本就保 ".0")
    // 双双背离,且违 agentStatLine.js 自述的同族铁律(AgentProgressLine/
    // TeammateSpinnerLine/CoordinatorAgentStatus/**Spinner** 全走 formatNumber 非
    // formatTokens、保留尾随 ".0")。换 ccFormatNumber 后三者重新一致。门控 KHY_CC_FORMAT
    // (同族门控)关 / 非有限 → 逐字节回退 spinner 历史本地规则(亦保 ".0")。
    const fmtTokens = (n) => {
      const ccf = require('./ccFormat');
      if (ccf.ccFormatEnabled(process.env)) {
        const out = ccf.ccFormatNumber(n);
        if (out) return out; // 非有限 → '' → 回退 legacy
      }
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return String(n);
    };
    let effortText = '';
    if (this._effort && (this._effort === 'max' || this._effort === 'high')) {
      effortText = `extended thinking · ${this._effort}`;
    } else if (this._effort) {
      effortText = this._effort;
    }
    const _spinnerMeta = require('./spinnerMeta');
    const parts = _spinnerMeta.buildStatusParts({
      timerText: elapsedStr,
      inputTokensText: this._inputTokens > 0 ? `↑ ${fmtTokens(this._inputTokens)} tokens` : '',
      outputTokensText: this._outputTokens > 0 ? `↓ ${fmtTokens(this._outputTokens)} tokens` : '',
      effortText,
      elapsedMs: Date.now() - this._startTime,
      verbose: false,
      hasTeammates: false,
      gateEnabled: _spinnerMeta.isEnabled(process.env),
    });
    const statusStr = parts.join(' · ');

    // Active polling indicator: solid dot (Claude-style, no sparkle in main line)
    const spinnerChar = SPINNER_ACTIVE_CHAR;

    // Stall detection (Claude Code style): based on time since last token,
    // not phase start. 3s threshold → yellow hint, 8s → red.
    const stallSec = (Date.now() - this._lastTokenAt) / 1000;
    let charColor;
    if (stallSec > 8) {
      // Deep stall: interpolate toward error red over 12s
      const t = Math.min(1, (stallSec - 8) / 12);
      const r = Math.round(215 + (255 - 215) * t);
      const g = Math.round(119 + (107 - 119) * t);
      const b = Math.round(87 + (128 - 87) * t);
      charColor = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    } else if (stallSec > 3) {
      // Early stall: interpolate from brand to amber over 5s
      const t = Math.min(1, (stallSec - 3) / 5);
      const r = Math.round(215 + (255 - 215) * t);
      const g = Math.round(119 + (193 - 119) * t);
      const b = Math.round(87 + (7 - 87) * t);
      charColor = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    } else {
      charColor = THEME.text;
    }

    const dot = c().hex(charColor)(spinnerChar);
    // Within the first 30s the byline can be empty (just the verb); omit the
    // empty "()" wrapper in that case.
    const plainText = statusStr
      ? `${label}...${detail} (${statusStr})`
      : `${label}...${detail}`;
    const maxCols = Math.max(40, (process.stdout.columns || 100) - 6);
    const compactPlain = displayWidth(plainText) > maxCols
      ? truncateToWidth(plainText, maxCols)
      : plainText;
    // Verb "shimmer": CC dims the whole working-verb except a 3-column spot that
    // sweeps right→left every SHIMMER_INTERVAL_MS (src/bridge/bridgeStatusUtil.ts
    // + Spinner.tsx). Backend logic lives in the pure leaf cli/spinnerShimmer.js;
    // here we only apply chalk dim(before)/normal(shimmer)/dim(after) to the verb
    // (`label`) prefix and leave the rest (`...detail (status)`) at normal weight —
    // exactly as CC's <Text dimColor>/<Text>/<Text dimColor> renderer does. Gate
    // KHY_SPINNER_SHIMMER off (or any failure / verb-was-truncated) → the exact
    // single-chalk path below, byte-identical to legacy.
    let coloredBody;
    if (spinnerShimmerEnabled(process.env) && label && compactPlain.startsWith(label)) {
      try {
        const tick = Math.floor((Date.now() - this._startTime) / SHIMMER_INTERVAL_MS);
        const gi = computeGlimmerIndex(tick, displayWidth(label));
        const seg = computeShimmerSegments(label, gi, displayWidth);
        if (seg.before + seg.shimmer + seg.after === label) {
          const rest = compactPlain.slice(label.length);
          coloredBody =
            c().hex(THEME.text).dim(seg.before) +
            c().hex(THEME.text)(seg.shimmer) +
            c().hex(THEME.text).dim(seg.after) +
            c().hex(THEME.text)(rest);
        }
      } catch { /* fall through to flat path */ }
    }
    if (coloredBody == null) coloredBody = c().hex(THEME.text)(compactPlain);
    const line = `${dot} ${coloredBody}`;

    if (!this._promptShown) {
      // First render: draw spinner line.
      process.stdout.write(`\r\x1b[K${line}`);
      this._promptShown = true;
      this._promptLines = 0;
      this._spinnerOffsetFromPrompt = 0;
      this._promptCursorAnchored = false;
      // No prompt scaffold — repl.js showBusyInterjectPrompt handles the prompt.
    } else {
      // Subsequent renders: erase current line + rewrite spinner.
      // No cursor offset tracking — just clear current line and rewrite.
      process.stdout.write(`\r\x1b[K${line}`);
    }

    // Show tip after 5 seconds, once per spinner lifetime
    if (!this._tipShown && elapsedSec >= 5) {
      this._tipShown = true;
    }
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (!isInteractiveInputActive()) {
      // Only clean up display when spinner actually rendered something.
      // When _render() was blocked (e.g. by isRaw), _promptShown stays false
      // and there is nothing to clear — blindly clearing would wipe the
      // busy interject prompt drawn by repl.js showBusyInterjectPrompt().
      if (this._promptShown) {
        // Simply clear the current line (spinner line)
        process.stdout.write('\r\x1b[K');
      }
      this._promptLines = 0;
      this._promptShown = false;
      this._spinnerOffsetFromPrompt = 0;
      this._promptCursorAnchored = false;
    }
  }
}

/**
 * Render a user message with gray background (Claude Code style).
 * Claude Code uses rgb(38,38,38) background for user messages.
 * @param {string} text - user message text
 */
function renderUserMessage(text) {
  // Claude Code: userMsgBg = rgb(38,38,38) — subtle dark background
  const bgColor = '#262626';
  const lines = text.split('\n');
  // Measure by display width so CJK (double-width) lines pad to a clean
  // rectangle — .length would under-count and leave the background ragged.
  const maxLen = Math.max(...lines.map(l => displayWidth(l)));
  console.log('');
  for (const line of lines) {
    const padded = line + ' '.repeat(Math.max(0, maxLen + 2 - displayWidth(line)));
    console.log(c().bgHex(bgColor).hex('#FFFFFF')(` ${padded}`));
  }
  console.log('');
}

module.exports = { DynamicSpinner, renderUserMessage };
