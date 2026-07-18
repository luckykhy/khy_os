/**
 * Busy-input & paste text classifiers for the classic REPL.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. All pure (no closure state, no chalk, no I/O): they classify
 * or summarize raw input text. The stateful paste-capture state machine
 * (`_consumeBracketedPaste`) stays in repl.js because it owns mutable capture
 * state; it consumes the pure marker/strip helpers exported here.
 */

/** Matches a `<pasted-content>…</pasted-content>` block; group 1 is the body. */
const PASTED_CONTENT_BLOCK_RE = /<pasted-content>\n([\s\S]*?)\n<\/pasted-content>/;

/**
 * Summarize a queued/raw input line for a one-line preview. Pasted-content
 * blocks collapse to `[Pasted text +N lines]` plus any surrounding supplement;
 * otherwise whitespace is collapsed and the text clamped to `maxLen` chars.
 */
function summarizeQueuedInputForDisplay(raw, maxLen = 48) {
  const text = String(raw || '');
  const pastedMatch = PASTED_CONTENT_BLOCK_RE.exec(text);
  if (pastedMatch) {
    const pastedBody = String(pastedMatch[1] || '');
    // M = CC getPastedTextRefNumLines(换行数,与 repl.js 粘贴胶囊同一 SSOT);门控关 →
    // 逐字节回退本处历史的 split('\n').length。门控开且换行数为 0(单行巨贴)→ CC 的
    // formatPastedTextRef 走裸 `[Pasted text]`(不显 "+0 lines"),与 CC 忠实对齐。
    const _refLines = require('../pastedRefLines');
    const legacyCount = pastedBody ? pastedBody.split('\n').length : 0;
    const lineCount = _refLines.pastedRefLineCountOr(pastedBody, legacyCount, process.env);
    const body = (_refLines.isEnabled(process.env) && lineCount === 0)
      ? '[Pasted text]'
      : `[Pasted text +${lineCount} lines]`;
    const supplement = text.replace(PASTED_CONTENT_BLOCK_RE, '').trim().replace(/\s+/g, ' ');
    const suffix = supplement
      ? ` · ${supplement.slice(0, maxLen)}${supplement.length > maxLen ? '...' : ''}`
      : '';
    return `${body}${suffix}`;
  }
  const compact = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

/**
 * Classify user input typed while the agent is busy into one of three modes
 * (Hermes-style): `interrupt` (explicit stop), `steer` (mid-course correction,
 * detected via explicit /steer|/s prefix or steer-intent patterns), or `queue`
 * (a new topic to run next). Pure: returns `{ mode, text }`.
 */
function classifyBusyInput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { mode: 'queue', text: trimmed };

  // 显式 /steer 或 /s 前缀
  const steerPrefixMatch = /^\/(?:steer|s)\s+([\s\S]+)$/i.exec(trimmed);
  if (steerPrefixMatch) return { mode: 'steer', text: steerPrefixMatch[1].trim() };

  // 显式中断关键词（完整匹配）
  if (/^(?:停[下止]?|取消|中断|abort|stop|cancel)\s*[!！.。]?\s*$/i.test(trimmed)) {
    return { mode: 'interrupt', text: trimmed };
  }

  // 长输入 > 300 字 → 新话题，排队
  if (trimmed.length > 300) return { mode: 'queue', text: trimmed };

  // Steer 语义检测
  const steerPatterns = [
    /别[用做写]/, /不要[用做那这写]/, /改[成用为]/, /换[个成一]个?(?:思路|方[法案式]|方向)?/,
    /加上/, /还[要需]/, /而且/, /但[是要]/, /另外/, /同时也/, /不如/,
    /顺便/, /(?:也|还)(?:把|将|得)/, /改改/, /调整[一下]*(?:方向|思路|方案)?/,
    /不是.*(?:而是|是)/, /(?:等等|等一下).*(?:先|别)/,
    /\b(?:don'?t|do not) (?:use|do|write|try)/i,
    /\b(?:instead|actually|wait|hold on|oh wait)/i,
    /\b(?:switch to|change to|try .* instead)/i,
    /\b(?:also |but |skip |ignore )\b/i,
    /\bnot that\b/i,
  ];
  for (const pat of steerPatterns) {
    if (pat.test(trimmed)) return { mode: 'steer', text: trimmed };
  }

  return { mode: 'queue', text: trimmed };
}

/**
 * Route a busy-typed line into a concrete front-end ACTION. Builds on
 * `classifyBusyInput` and additionally recognizes the `/s!` | `/steer!` urgent
 * preempt prefix (which the plain classifier intentionally does not, since its
 * steer prefix requires whitespace after `/s`). Pure: returns `{ action, text }`
 * where action is one of:
 *   - `urgent`    — /s! preempt: cancel the in-flight call and re-issue this turn
 *   - `steer`     — inject a 「方向修正」 at the next tool boundary
 *   - `interrupt` — stop the turn, run this input next
 *   - `queue`     — new topic, run at end-of-turn (FIFO)
 * Shared by the Ink TUI (useQueryBridge.submit) so its busy routing matches the
 * classic REPL exactly.
 */
function routeBusyInput(text) {
  const raw = String(text || '');
  const urgent = /^\/(?:steer|s)!\s+([\s\S]+)$/i.exec(raw.trim());
  if (urgent) return { action: 'urgent', text: urgent[1].trim() };
  const { mode, text: classified } = classifyBusyInput(raw);
  if (mode === 'steer') return { action: 'steer', text: classified };
  if (mode === 'interrupt') return { action: 'interrupt', text: classified };
  return { action: 'queue', text: classified };
}

/**
 * Find the earliest occurrence among `markers` within `text`. Returns
 * `{ idx, marker }` for the first-appearing marker, or null when none match.
 */
function findFirstMarker(text, markers) {
  let best = null;
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx === -1) continue;
    if (!best || idx < best.idx) best = { idx, marker };
  }
  return best;
}

/** Strip bracketed-paste escape artifacts (DECSET 2004 + 200~/201~ markers). */
function stripBracketArtifacts(text) {
  return String(text || '')
    .replace(/\u001b\[\?2004[hl]/g, '')
    .replace(/\u001b\[(200|201)~/g, '')
    .replace(/\[(200|201)~/g, '')
    .replace(/^00~/, '')
    .replace(/01~$/, '');
}

module.exports = {
  PASTED_CONTENT_BLOCK_RE,
  summarizeQueuedInputForDisplay,
  classifyBusyInput,
  routeBusyInput,
  findFirstMarker,
  stripBracketArtifacts,
};
