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

const { buildLiveStatusBroadcast } = require('../../statusBroadcast');
const { effectiveCols } = require('../effectiveCols'); // 有效列宽单一真源(右栏收窄)
const inkRuntime = require('../inkRuntime');

const liveHeightClamp = require('./liveHeightClamp');
const liveTimelineLazyNorm = require('./liveTimelineLazyNorm');
const ProcessGroup = require('./ProcessGroup');
// 段间空行分隔门控单一真源(与 Transcript 共用):思考/工具组/回答三段之间恰好
// 一个空行(仅相邻两段都存在时插入);空行行数计入 liveHeightClamp 预算,防 staircase。
const { sectionGapEnabled } = require('./sectionGap');

// Tier-gated, PREFIX-STABLE normalization for the live preview. Strong models
// (selfRender) are trusted — only invisible/control bytes are stripped. Small/
// unknown models get normalizeStreaming (sentinels, role echo, leaked <think>,
// blank-line runs) so a messy small-model stream displays cleanly. Both passes
// are prefix-stable (no fence-closing/dedup/trim), so the preview never jumps as
// more text arrives. Applied before tailing so height budgets reflect what shows.
let _normalizer = null;
function _rawNormLive(text, selfRender) {
  if (!text) {
    return text;
  }
  if (_normalizer === null) {
    try {
      _normalizer = require('../../modelTextNormalizer') || false;
    } catch {
      _normalizer = false;
    }
  }
  if (!_normalizer) {
    return text;
  }
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
function _rawMdStream(text, columns) {
  if (!text) {
    return text;
  }
  if (_mdStream === null) {
    try {
      _mdStream = require('../../markdownRenderer').renderMarkdownStreaming || false;
    } catch {
      _mdStream = false;
    }
  }
  if (!_mdStream) {
    return text;
  }
  // 任务#16: pass the render width through — previously only the cache key knew
  // the left-column width while the renderer still wrapped code boxes/tables at
  // the FULL terminal width, producing rows wider than the left column that ink
  // then re-wrapped (ugly double wrap). Invalid/absent columns → legacy full width.
  try {
    return _mdStream(text, columns);
  } catch {
    return text;
  }
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
const ToolLines = require('./ToolLines');
function mdStream(text, width) {
  // renderCached calls its rawFn with (text) only, so close over the width here
  // — the cache key already carries it, keeping key and render width in sync.
  const raw = (t) => _rawMdStream(t, width);
  try {
    return _streamMdCache.renderCached(text, width, raw, process.env);
  } catch {
    return raw(text);
  }
}

// NOTE: the tail-cut logic (raw-line AND visual-row measured) now lives in the
// pure leaf ./liveHeightClamp. It bounds thinking/answer/timeline previews in
// VISUAL rows (soft-wrap + CJK aware) so the live region stays < terminal rows
// on every frame — anti-staircase, gate KHY_LIVE_HARD_CLAMP (default on) falls
// back to byte-identical raw-line tailing. See liveHeightClamp.js for details.

function StreamingBlock({ streaming, status, expanded, reserveRows, contentWidth }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!streaming) {
    return null;
  }

  // Viewport-relative budgets. Reserve rows for the prompt frame (~3), footer
  // (~2), spacing, and any tool lines (capped). Fall back to a safe fixed cap
  // when rows are unavailable/unreliable (some Windows terminals report 0).
  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;
  // Width for the hard clamp (liveHeightClamp): a raw line wider than the
  // available columns soft-wraps to ⌈width/columns⌉ visual rows, so the body/
  // thinking tails must budget in VISUAL rows (not raw line count) to keep the
  // whole live region < rows on EVERY frame (incl. the first) — see
  // liveHeightClamp.js. 任务#12: when the right-column board shares the flex
  // row, this block only spans the LEFT column — App feeds the left-column
  // width via `contentWidth` (pure leaf sidebarLayout.mainColumnCols). Budgeting
  // against the FULL terminal width would undercount wrapped rows, overflow the
  // viewport and mis-erase frames (text smeared across the board + the board
  // pushed down). Absent/invalid prop → legacy full-width path, byte-identical.
  // The fallback goes through effectiveCols so a rail-active terminal still gets
  // `cols - 栏宽` rather than the full width (门控关 → 真实列宽 → legacy)。
  const columns =
    Number.isFinite(contentWidth) && contentWidth > 0
      ? Math.floor(contentWidth)
      : effectiveCols(80);
  const toolCount = (streaming.tools && streaming.tools.length) || 0;
  // `reserveRows` (when App computes it via liveRegionBudget) folds the height of
  // the sibling live panels below us (task checklist / plan / queue) into our
  // reserve, so the WHOLE live region stays < rows and ink never fullscreen-clears
  // (the scroll-jump bug). When absent (gate off / leaf unavailable / direct use),
  // fall back to the legacy reserve byte-for-byte.
  const reserve =
    typeof reserveRows === 'number' && Number.isFinite(reserveRows) && reserveRows >= 0
      ? reserveRows
      : 9 + Math.min(toolCount, 6);
  const liveBudget = Math.max(6, rows - reserve);
  // When thinking is present, give it a minority share; the answer leads.
  const thinkBudget = streaming.thinking ? Math.max(3, Math.floor(liveBudget * 0.3)) : 0;
  const bodyBudget = Math.max(6, liveBudget - thinkBudget);

  const selfRender = !!streaming.selfRender;
  const children = [];
  // Blank-row section separation (gate KHY_TUI_SECTION_GAP, default on). A
  // separator is one ' ' Text row = exactly 1 visual row, charged against the
  // body budget below so the live region never exceeds the viewport.
  const gapOn = sectionGapEnabled(process.env);
  const hasThinking = !!streaming.thinking;
  const gapRow = (key) => h(Text, { key }, ' ');

  if (streaming.thinking) {
    const t = liveHeightClamp.tailToVisualRows(
      normLive(streaming.thinking, selfRender),
      thinkBudget,
      columns,
      process.env
    );
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
    rawTimeline,
    (txt) => normLive(txt, selfRender),
    process.env
  );
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
    let tailed = liveHeightClamp.tailTimelineToVisualRows(
      timeline,
      bodyBudget,
      columns,
      process.env,
      _normalizeText
    );
    if (gapOn) {
      // Separator rows consume live rows too: probe the kept window, count the
      // blank rows it needs (thinking↔body + between adjacent body sections),
      // then re-tail with the budget minus separators. The second pass keeps ≤
      // the same sections, so content + blanks stays ≤ bodyBudget every frame.
      const countSections = (entries) =>
        ProcessGroup.groupConsecutiveTools(entries).filter(
          (e) => (e.type === 'text' && e.text) || (e.type === 'tools' && e.tools.length > 0)
        ).length;
      const n = countSections(tailed.entries);
      const seps = Math.max(0, n - 1) + (hasThinking && n > 0 ? 1 : 0);
      if (seps > 0) {
        tailed = liveHeightClamp.tailTimelineToVisualRows(
          timeline,
          Math.max(1, bodyBudget - seps),
          columns,
          process.env,
          _normalizeText
        );
      }
    }
    const entries = tailed.entries.map((e) =>
      e.type === 'text' ? { ...e, text: mdStream(e.text, columns) } : e
    );
    // One blank row between the thinking section and the first body row.
    let pendingGap = gapOn && hasThinking;
    if (tailed.truncated) {
      if (pendingGap) {
        children.push(gapRow('gap-think'));
        pendingGap = false;
      }
      children.push(
        h(
          Text,
          { key: 'body-ell', dimColor: true },
          '⋯ 实时仅显示末尾，完整内容在本轮结束后归入上方历史'
        )
      );
    }
    // Merge consecutive tool steps in the kept window into one collapsible
    // ProcessGroup so the live preview matches the committed transcript.
    ProcessGroup.groupConsecutiveTools(entries).forEach((e, i) => {
      if (e.type === 'text') {
        if (e.text) {
          if (pendingGap) {
            children.push(gapRow(`gap${i}`));
          }
          children.push(h(Text, { key: `t${i}` }, e.text));
          pendingGap = gapOn;
        }
      } else if (e.type === 'tools' && e.tools.length > 0) {
        if (pendingGap) {
          children.push(gapRow(`gap${i}`));
        }
        children.push(h(ProcessGroup, { key: `g${i}`, tools: e.tools, expanded, live: true }));
        pendingGap = gapOn;
      }
    });
  } else {
    if (streaming.text) {
      // Single tail on raw normalized text, then render markdown once (see the
      // timeline path: this removes the window jump from re-tailing rendered
      // lines). Slight post-render overflow is absorbed by the `reserve` margin.
      // Section gaps (thinking↔text, text↔tools) are pre-charged to the budget.
      const sepReserve = gapOn
        ? (hasThinking ? 1 : 0) + (streaming.tools && streaming.tools.length > 0 ? 1 : 0)
        : 0;
      const tailed = liveHeightClamp.tailToVisualRows(
        normLive(streaming.text, selfRender),
        Math.max(1, bodyBudget - sepReserve),
        columns,
        process.env
      );
      if (gapOn && hasThinking) {
        children.push(gapRow('gap-think'));
      }
      if (tailed.truncated) {
        children.push(
          h(
            Text,
            { key: 'text-ell', dimColor: true },
            '⋯ 实时仅显示末尾，完整内容在本轮结束后归入上方历史'
          )
        );
      }
      children.push(h(Text, { key: 'text' }, mdStream(tailed.text, columns)));
    }
    if (streaming.tools && streaming.tools.length > 0) {
      if (gapOn && (streaming.text || hasThinking)) {
        children.push(gapRow('gap-tools'));
      }
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
    children.push(
      h(Text, { key: 'status-broadcast', color: 'cyan' }, `● ${broadcast}  (ctrl+o 展开完整内容)`)
    );
  }

  if (children.length === 0) {
    return null;
  }
  return h(Box, { flexDirection: 'column' }, ...children);
}

module.exports = StreamingBlock;
