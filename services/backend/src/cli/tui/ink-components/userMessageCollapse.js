'use strict';

// Long user-message head+tail collapse — pure leaf (zero IO, deterministic,
// fail-soft). Aligns the LOGIC BEHIND Claude Code's user-prompt display cap,
// NOT just its look.
//
// CC reference: src/components/messages/UserPromptMessage.tsx (MAX_DISPLAY_CHARS
// / TRUNCATE_HEAD_CHARS / TRUNCATE_TAIL_CHARS) + src/utils/stringUtils.ts
// countCharInString. The rationale CC documents (the "背后的逻辑"): piping a
// large file via stdin — e.g. `{ cat 11k-line-file; echo prompt; } | claude` —
// creates ONE giant user message whose <Text> node the fullscreen Ink renderer
// must wrap/output on EVERY frame, causing 500ms+ keystroke latency. React.memo
// skips the React render, but the Ink output pass still iterates the full
// mounted text. So the displayed text is capped to head + tail with a
// `… +N lines …` marker. Head+tail (not just head) because that shell idiom
// puts the user's ACTUAL question at the END.
//
// khy parity: cli/tui/ink-components/Transcript.js::buildUserMessageBox (and the
// legacy transparent-echo branch) wrapped the FULL content with no cap — the
// exact latency scenario CC guards against. This leaf reproduces CC's algorithm
// faithfully so the display is capped identically.
//
// Honest divergence: this caps DISPLAY only; the stored/submitted message is
// unchanged (the model still receives the full text — the cap is a render-time
// perf guard, never a data mutation). Gate off → verbatim passthrough.

const MAX_DISPLAY_CHARS = 10000;
const TRUNCATE_HEAD_CHARS = 2500;
const TRUNCATE_TAIL_CHARS = 2500;

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env) {
  const raw = env && env.KHY_USER_MSG_COLLAPSE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// Port of CC stringUtils.countCharInString(str, char, start): count occurrences
// of a single character in `str` at index >= start. Uses indexOf like CC so the
// counting semantics match byte-for-byte.
function countCharInString(str, char, start) {
  const s = String(str == null ? '' : str);
  let count = 0;
  let i = s.indexOf(char, start > 0 ? start : 0);
  while (i !== -1) {
    count++;
    i = s.indexOf(char, i + 1);
  }
  return count;
}

// Faithful port of CC UserPromptMessage displayText memo. Returns `text`
// unchanged when at/under the cap or when disabled; otherwise head + a
// `… +N lines …` marker (N = newlines strictly between the head cut and the
// tail cut) + tail. Fail-soft: any error → original text.
function collapseLongUserMessage(text, env) {
  try {
    if (typeof text !== 'string' || text.length === 0) return text;
    if (!isEnabled(env || (typeof process !== 'undefined' ? process.env : {}))) return text;
    if (text.length <= MAX_DISPLAY_CHARS) return text;
    const head = text.slice(0, TRUNCATE_HEAD_CHARS);
    const tail = text.slice(-TRUNCATE_TAIL_CHARS);
    // Newlines in [HEAD, end) minus newlines in the tail = newlines hidden in
    // the omitted middle region [HEAD, len-TAIL). Mirrors CC exactly.
    const hiddenLines = countCharInString(text, '\n', TRUNCATE_HEAD_CHARS)
      - countCharInString(tail, '\n');
    return `${head}\n… +${hiddenLines} lines …\n${tail}`;
  } catch {
    return text;
  }
}

module.exports = {
  isEnabled,
  countCharInString,
  collapseLongUserMessage,
  // Constants exported for tests / cross-reference.
  MAX_DISPLAY_CHARS,
  TRUNCATE_HEAD_CHARS,
  TRUNCATE_TAIL_CHARS,
};
