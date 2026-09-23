/**
 * Thinking-stream render helpers for the classic REPL.
 *
 * Split from cli/repl/streamRender.js as a behavior-preserving leaf: the
 * self-contained "reasoning is streaming right now" cluster (char-width →
 * incremental dim render → close + summary line). streamRender.js re-exports
 * these three symbols so its public surface stays byte-identical. The only
 * module-local state is a lazy chalk cache (a perf cache, harmless duplicate).
 */

// Lazy chalk cache (mirrors the original module-level cache in repl.js).
let _chalk;

function getDisplayWidthChar(ch) {
  // Use formatters.displayWidth for accurate single-char width (CJK/emoji/grapheme).
  // Fast path for common ASCII first.
  const code = ch.codePointAt(0);
  if (!code) {
    return 1;
  }
  if (code >= 0x20 && code < 0x7f) {
    return 1;
  }
  try {
    const { displayWidth } = require('../formatters');
    return displayWidth(ch);
  } catch {
    // Fallback: manual CJK detection
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fa1f)
    ) {
      return 2;
    }
    return 1;
  }
}

function streamThinkingChunk(text, streamState, c) {
  // Default: SHOW thinking text, consistent with the TUI — the /thinking toggle is
  // the single control over whether reasoning is produced+shown. Set
  // KHY_SHOW_THINKING_TEXT=0/false/off to force-hide regardless of the toggle.
  const showThinking = String(process.env.KHY_SHOW_THINKING_TEXT ?? '').toLowerCase();
  if (showThinking === '0' || showThinking === 'false' || showThinking === 'off') {
    return;
  }

  const content = String(text || '').replace(/\r/g, '');
  if (!content) {
    return;
  }

  // Track thinking text length for final summary
  if (!streamState._thinkingLen) {
    streamState._thinkingLen = 0;
  }
  streamState._thinkingLen += content.length;

  const maxCols = Math.max(24, (process.stdout.columns || 80) - 6);
  const prefix = '  ';

  // Batch all character writes into a single buffer to prevent flicker on Windows
  const buf = [];

  if (!streamState.thinkingLineOpen) {
    buf.push(prefix);
    streamState.thinkingLineOpen = true;
    streamState.thinkingCol = 0;
  }

  for (const ch of content) {
    if (ch === '\n') {
      buf.push('\n');
      buf.push(prefix);
      streamState.thinkingCol = 0;
      continue;
    }

    const charWidth = getDisplayWidthChar(ch);
    if (streamState.thinkingCol + charWidth > maxCols) {
      buf.push('\n');
      buf.push(prefix);
      streamState.thinkingCol = 0;
    }

    buf.push(c.dim(ch));
    streamState.thinkingCol += charWidth;
  }

  if (buf.length > 0) {
    process.stdout.write(buf.join(''));
  }
}

function closeThinkingStream(streamState) {
  if (!streamState.thinkingLineOpen) {
    return;
  }
  process.stdout.write('\n');
  streamState.thinkingLineOpen = false;
  streamState.thinkingCol = 0;

  // Print a summary line showing how long thinking took
  const c = () => (_chalk ??= require('chalk').default || require('chalk'));
  const thinkingLen = streamState._thinkingLen || 0;
  if (thinkingLen > 0) {
    const elapsed = streamState._thinkingStartAt
      ? Math.round((Date.now() - streamState._thinkingStartAt) / 1000)
      : 0;
    const timeStr = elapsed > 0 ? ` ${elapsed}s` : '';
    const charStr = thinkingLen > 100 ? ` · ${thinkingLen} 字符` : '';
    console.log(c().dim(`  💭 思考完成${timeStr}${charStr}`));
    console.log('');
  }
}

module.exports = {
  getDisplayWidthChar,
  streamThinkingChunk,
  closeThinkingStream,
};
