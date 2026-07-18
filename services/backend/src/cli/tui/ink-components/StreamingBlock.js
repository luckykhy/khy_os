'use strict';

/**
 * StreamingBlock — renders the current (in-flight) AI turn: thinking text,
 * streamed answer text, and live tool calls.
 *
 * IMPORTANT (anti-staircase): the live region MUST stay shorter than the
 * terminal viewport. Ink re-renders this dynamic region on every chunk by
 * erasing the previous frame (cursor-up + clear). When the rendered height
 * exceeds the viewport, Ink's eraseLines count is wrong — worst on Windows
 * conhost — and the prompt border "staircases" with cascading `────` lines.
 * So we show only the TAIL of thinking/answer text here; the COMPLETE turn is
 * committed to the <Static> transcript on finalize (useQueryBridge), so tailing
 * the live preview loses nothing — the full text lands in scrollback above.
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');
const ToolLines = require('./ToolLines');
const ProcessGroup = require('./ProcessGroup');
const liveHeightClamp = require('./liveHeightClamp');
const liveTimelineLazyNorm = require('./liveTimelineLazyNorm');
const { buildLiveStatusBroadcast } = require('../../statusBroadcast');

// Tier-gated, PREFIX-STABLE normalization for the live preview. Strong models
// (selfRender) are trusted — only invisible/control bytes are stripped. Small/
// unknown models get normalizeStreaming (sentinels, role echo, leaked <think>,
// blank-line runs) so a messy small-model stream displays cleanly. Both passes
// are prefix-stable (no fence-closing/dedup/trim), so the preview never jumps as
// more text arrives. Applied before tailing so height budgets reflect what shows.
let _normalizer = null;
function _rawNormLive(text, selfRender) {
  if (!text) return text;
  if (_normalizer === null) {
    try { _normalizer = require('../../modelTextNormalizer') || false; }
    catch { _normalizer = false; }
  }
  if (!_normalizer) return text;
  try {
    return selfRender ? _normalizer.sanitize(text) : _normalizer.normalizeStreaming(text);
  } catch {
    return text;
  }
}

// StreamingBlock re-normalizes EVERY text segment of the whole accumulated
// timeline on every frame (~25fps). All but the single growing segment are
// frozen (identical text every frame), so re-running the regex passes on them
// is O(n²)/turn of pure waste — the dominant lag on long streaming answers.
// Route through streamNormCache: a bounded content-keyed memo of the pure
// _rawNormLive output. Frozen segments hit the cache; only the growing segment
// recomputes → O(n²)→O(n)/turn. Gate KHY_STREAM_NORM_CACHE (default on) off →
// calls _rawNormLive directly, byte-identical to before.
const _streamNormCache = require('./streamNormCache');
function normLive(text, selfRender) {
  try {
    return _streamNormCache.normalizeCached(text, selfRender, _rawNormLive, process.env);
  } catch {
    return _rawNormLive(text, selfRender);
  }
}

// Stream-safe markdown for the live preview. Renders the SAME formatting the
// committed transcript applies (renderMarkdownLite) so the live→committed handoff
// no longer jumps from raw syntax to a styled box — and closes a dangling code
// fence so an in-progress block shows as a graceful code box instead of bare
// backticks. Result is LRU-cached, and we only ever feed it a viewport-bounded
// tail (see below), so per-frame CPU stays low.
let _mdStream = null;
function _rawMdStream(text) {
  if (!text) return text;
  if (_mdStream === null) {
    try { _mdStream = require('../../markdownRenderer').renderMarkdownStreaming || false; }
    catch { _mdStream = false; }
  }
  if (!_mdStream) return text;
  try { return _mdStream(text); } catch { return text; }
}

// renderMarkdownStreaming's INNER renderMarkdownLite is LRU-cached, but its OUTER
// fence-scan `s.match(/^[ \t]*```/gm)` runs on EVERY call — including cache-hit
// frozen segments — allocating a match array over the whole segment each frame.
// StreamingBlock re-renders every text segment of the tail window each frame
// (~25fps); all but the growing segment are frozen, so that per-frame fence regex
// is O(n²)/turn of pure waste. Route through streamMdCache: a bounded content-keyed
// memo of the WHOLE renderMarkdownStreaming output keyed by (columns, text), so a
// frozen segment hits the cache and skips even the fence scan; only the growing
// segment recomputes. Gate KHY_STREAM_MD_CACHE (default on) off → calls
// _rawMdStream directly, byte-identical to before.
const _streamMdCache = require('./streamMdCache');
function mdStream(text) {
  try {
    return _streamMdCache.renderCached(text, process.stdout.columns || 80, _rawMdStream, process.env);
  } catch {
    return _rawMdStream(text);
  }
}

// NOTE: the tail-cut logic (raw-line AND visual-row measured) now lives in the
// pure leaf ./liveHeightClamp. It bounds thinking/answer/timeline previews in
// VISUAL rows (soft-wrap + CJK aware) so the live region stays < terminal rows
// on every frame — anti-staircase, gate KHY_LIVE_HARD_CLAMP (default on) falls
// back to byte-identical raw-line tailing. See liveHeightClamp.js for details.

function StreamingBlock({ streaming, status, expanded, reserveRows }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!streaming) return null;

  // Viewport-relative budgets. Reserve rows for the prompt frame (~3), footer
  // (~2), spacing, and any tool lines (capped). Fall back to a safe fixed cap
  // when rows are unavailable/unreliable (some Windows terminals report 0).
  const rows = (process.stdout.rows && process.stdout.rows > 0) ? process.stdout.rows : 24;
  // Terminal width for the hard clamp (liveHeightClamp): a raw line wider than
  // `columns` soft-wraps to ⌈width/columns⌉ visual rows, so the body/thinking
  // tails must budget in VISUAL rows (not raw line count) to keep the whole live
  // region < rows on EVERY frame (incl. the first) — see liveHeightClamp.js.
  const columns = (process.stdout.columns && process.stdout.columns > 0) ? process.stdout.columns : 80;
  const toolCount = (streaming.tools && streaming.tools.length) || 0;
  // `reserveRows` (when App computes it via liveRegionBudget) folds the height of
  // the sibling live panels below us (task checklist / plan / queue) into our
  // reserve, so the WHOLE live region stays < rows and ink never fullscreen-clears
  // (the scroll-jump bug). When absent (gate off / leaf unavailable / direct use),
  // fall back to the legacy reserve byte-for-byte.
  const reserve = (typeof reserveRows === 'number' && Number.isFinite(reserveRows) && reserveRows >= 0)
    ? reserveRows
    : (9 + Math.min(toolCount, 6));
  const liveBudget = Math.max(6, rows - reserve);
  // When thinking is present, give it a minority share; the answer leads.
  const thinkBudget = streaming.thinking ? Math.max(3, Math.floor(liveBudget * 0.3)) : 0;
  const bodyBudget = Math.max(6, liveBudget - thinkBudget);

  const selfRender = !!streaming.selfRender;
  const children = [];

  if (streaming.thinking) {
    const t = liveHeightClamp.tailToVisualRows(normLive(streaming.thinking, selfRender), thinkBudget, columns, process.env);
    if (t.truncated) {
      children.push(h(Text, { key: 'think-ell', dimColor: true }, '  ⋯ 思考（仅显示末尾）'));
    }
    children.push(h(Text, { key: 'think', dimColor: true }, t.text));
  }

  // Body: render the tail of the ordered timeline so the live preview shows the
  // real text↔tool interleaving (not all-text-then-all-tools). Fall back to the
  // flat text/tools fields if a timeline isn't present. Text segments are
  // normalized (tier-gated) BEFORE tailing so the height budget reflects the
  // cleaned text that is actually shown.
  const rawTimeline = Array.isArray(streaming.timeline) ? streaming.timeline : null;
  // 惰性归一化(消每帧对整条时间线的 normalize 预映射分配 churn):门控开 → 原样时间线 + normalizer
  // 交给 tail 函数,只归一化尾部实际触及的少数 entry;门控关 → 预映射(逐字节回退今日)。
  const _lazyNorm = liveTimelineLazyNorm.resolveTimelineNorm(
    rawTimeline, (txt) => normLive(txt, selfRender), process.env);
  const timeline = _lazyNorm.timeline;
  const _normalizeText = _lazyNorm.normalizeText;
  if (timeline && timeline.length > 0) {
    // Single tail on the (cheap) normalized RAW text to bodyBudget, THEN render
    // stream-safe markdown once. The old two-pass (pre-tail raw+slack → render →
    // re-tail the RENDERED lines) made the visible window's top edge jump as
    // markdown changed line counts mid-stream — every new fence border or wrap
    // shifted where the second tail cut. Tailing once on raw lines keeps the
    // window anchored to a stable text boundary; the few extra lines markdown
    // adds (fence borders, wrapping) are absorbed by the viewport `reserve`
    // margin (anti-staircase).
    const tailed = liveHeightClamp.tailTimelineToVisualRows(timeline, bodyBudget, columns, process.env, _normalizeText);
    const entries = tailed.entries.map((e) =>
      e.type === 'text' ? { ...e, text: mdStream(e.text) } : e);
    if (tailed.truncated) {
      children.push(h(Text, { key: 'body-ell', dimColor: true }, '⋯ 实时仅显示末尾，完整内容在本轮结束后归入上方历史'));
    }
    // Merge consecutive tool steps in the kept window into one collapsible
    // ProcessGroup so the live preview matches the committed transcript.
    ProcessGroup.groupConsecutiveTools(entries).forEach((e, i) => {
      if (e.type === 'text') {
        if (e.text) children.push(h(Text, { key: `t${i}` }, e.text));
      } else if (e.type === 'tools' && e.tools.length > 0) {
        children.push(h(ProcessGroup, { key: `g${i}`, tools: e.tools, expanded, live: true }));
      }
    });
  } else {
    if (streaming.text) {
      // Single tail on raw normalized text, then render markdown once (see the
      // timeline path: this removes the window jump from re-tailing rendered
      // lines). Slight post-render overflow is absorbed by the `reserve` margin.
      const tailed = liveHeightClamp.tailToVisualRows(normLive(streaming.text, selfRender), bodyBudget, columns, process.env);
      if (tailed.truncated) {
        children.push(h(Text, { key: 'text-ell', dimColor: true }, '⋯ 实时仅显示末尾，完整内容在本轮结束后归入上方历史'));
      }
      children.push(h(Text, { key: 'text' }, mdStream(tailed.text)));
    }
    if (streaming.tools && streaming.tools.length > 0) {
      children.push(h(ToolLines, { key: 'tools', tools: streaming.tools, expanded, live: true }));
    }
  }

  // Status broadcast (状态播报) — Claude-Code-style aggregate present-progressive
  // line summarizing every tool running RIGHT NOW (across the whole turn, even
  // ones scrolled out of the tail window above). Bottom-anchored like CC's live
  // status line; the real command/target stays visible on the per-tool rows
  // beneath ⎿. Gate KHY_STATUS_BROADCAST off → '' → byte-identical to before.
  const broadcast = buildLiveStatusBroadcast(streaming.tools);
  if (broadcast) {
    children.push(h(Text, { key: 'status-broadcast', color: 'cyan' }, `● ${broadcast}  (ctrl+o 展开)`));
  }

  if (children.length === 0) return null;
  return h(Box, { flexDirection: 'column' }, ...children);
}

module.exports = StreamingBlock;
