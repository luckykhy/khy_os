/**
 * Streaming text + thinking render helpers.
 *
 * Extracted verbatim from cli/repl.js as part of the behavior-preserving
 * god-file split. These operate on a caller-supplied `streamState` object;
 * the only module-local state is a lazy chalk cache (a perf cache, duplicated
 * here harmlessly). Reuses the existing ../streamingMarkdown, ../formatters,
 * ../aiRenderer and ../syncOutput modules — no rendering logic is reimplemented.
 */
const { MarkdownStreamState } = require('../streamingMarkdown');

function mapToolToPhaseLabel(toolName = '') {
  // Claude Code style: use English tool display names
  try {
    const renderer = require('../aiRenderer');
    return renderer.getToolDisplayName(toolName);
  } catch {
    const n = String(toolName || '').toLowerCase();
    if (n.includes('read')) {
      return 'Read';
    }
    if (n.includes('write') || n.includes('edit')) {
      return 'Write';
    }
    if (n.includes('search') || n.includes('grep') || n.includes('glob')) {
      return 'Search';
    }
    if (n.includes('bash') || n.includes('shell') || n.includes('command')) {
      return 'Bash';
    }
    return toolName || 'Tool';
  }
}

/**
 * Buffer AI text during streaming with incremental rendering.
 *
 * Inspired by Claude Code's "stable prefix / unstable suffix" approach:
 * - Text is accumulated in _textBuffer
 * - On each chunk arrival, we find the last stable paragraph boundary (\n\n)
 *   or sentence boundary (。！？.\n) and render everything before it
 * - The unstable tail is kept for the next chunk
 * - Code fences (```) are never split: we wait for the closing fence
 *
 * This gives the user immediate visual feedback instead of waiting for the
 * entire response to finish before seeing any output.
 */
function bufferTextChunk(text, streamState) {
  if (!text) {
    return;
  }

  // G1/G2: 使用 LineBuffer + AdaptiveChunker 替代原始字符串拼接
  if (streamState._chunker) {
    streamState._lineBuffer.push(text);
    streamState._chunker.tick();
    // 同步 _textBuffer 供 flushTextBuffer 和流结束检查使用
    streamState._textBuffer = streamState._lineBuffer._pending;
    return;
  }

  // Fallback: 兼容旧路径（不应到达）
  if (!streamState._textBuffer) {
    streamState._textBuffer = '';
  }
  streamState._textBuffer += text;
  _tryIncrementalFlush(streamState);
}

/**
 * Find the last safe split point in the buffer and render everything before it.
 * Safe boundaries (in priority order):
 *   1. Paragraph break: \n\n
 *   2. Line break after sentence-ending punctuation: [。！？!?.]\n
 *   3. Line break: \n (only when buffer > 200 chars to avoid splitting short responses)
 * Never split inside an open code fence.
 */
function _tryIncrementalFlush(streamState) {
  const raw = streamState._textBuffer || '';
  if (!raw || raw.length < 30) {
    return;
  } // too short, wait for more

  // Check for open code fence — don't flush if we're inside one
  const fenceMatches = raw.match(/^```/gm);
  if (fenceMatches && fenceMatches.length % 2 !== 0) {
    return;
  } // odd = unclosed fence

  // Find the best split point
  let splitIdx = -1;

  // Priority 1: paragraph boundary (\n\n)
  const paraIdx = raw.lastIndexOf('\n\n');
  if (paraIdx > 0) {
    splitIdx = paraIdx + 2;
  }

  // Priority 2: sentence-end + newline
  if (splitIdx < 0) {
    const sentenceNewline = /[。！？!?.:：]\n/g;
    let m;
    while ((m = sentenceNewline.exec(raw)) !== null) {
      splitIdx = m.index + m[0].length;
    }
  }

  // Priority 3: plain newline (only for longer buffers)
  if (splitIdx < 0 && raw.length > 200) {
    const nlIdx = raw.lastIndexOf('\n');
    if (nlIdx > 0) {
      splitIdx = nlIdx + 1;
    }
  }

  if (splitIdx <= 0) {
    return;
  }

  // Don't split in the middle of a code fence block
  const beforeSplit = raw.slice(0, splitIdx);
  const fencesInBefore = beforeSplit.match(/^```/gm);
  if (fencesInBefore && fencesInBefore.length % 2 !== 0) {
    return;
  }

  // Don't split in the middle of a markdown table block
  // A table is a contiguous run of lines matching /^\s*\|.*\|/
  const afterSplit = raw.slice(splitIdx);
  const beforeLines = beforeSplit.trimEnd().split('\n');
  const lastLineOfBefore = beforeLines[beforeLines.length - 1] || '';
  const afterLines = afterSplit.split('\n');
  const firstLineOfAfter = (afterLines[0] || '').trim();
  // Case 1: split point is between two table rows
  if (/^\s*\|.*\|/.test(lastLineOfBefore) && /^\s*\|.*\|/.test(firstLineOfAfter)) {
    return; // still inside a table, wait for more data
  }
  // Case 2: afterSplit starts with a table row and beforeSplit recently had table rows
  // (handles tables separated by a blank line in AI output)
  if (/^\s*\|.*\|/.test(firstLineOfAfter)) {
    const recentTableLine = beforeLines.slice(-5).some((l) => /^\s*\|.*\|/.test(l));
    if (recentTableLine) {
      return;
    } // likely a continuation of the same table
  }
  // Case 3: beforeSplit ends with a table row but afterSplit has more table rows coming
  if (
    /^\s*\|.*\|/.test(lastLineOfBefore) &&
    afterLines.slice(0, 3).some((l) => /^\s*\|.*\|/.test(l.trim()))
  ) {
    return; // table continues after a gap
  }

  const toRender = beforeSplit.trim();
  streamState._textBuffer = raw.slice(splitIdx);

  if (!toRender) {
    return;
  }
  _renderTextBlock(toRender);
}

// Strong breakpoints for non-force streaming flush (tool call interruption).
const _TEXT_STRONG_BREAK_TAIL_RE = /[\s\n。，、；：！？.,;:!?…\u3000)\]》）】」』"'`]$/;
const _NONFORCE_MIN_VISIBLE_CHARS = 14;
const _NONFORCE_TAIL_HOLD_CHARS = 18;

function flushTextBuffer(streamState, c, force = false) {
  // G1/G2: 如果有 AdaptiveChunker，优先使用新管道
  if (streamState._chunker && force) {
    streamState._chunker.flushAll();
    // 末句修复：chunker.flushAll() 经渲染回调把残余文本喂进 MarkdownStreamState，
    // 而 feed() 会把最后一行「无 \n 结尾」的句子停在 _remainder，只有 flush() 才吐出。
    // 强制 flush 是流/段结束语义，必须连带 flush 流式 markdown，否则模型最终回答的
    // 最后一句（多数无换行结尾）会被静默丢弃——尤其多轮迭代收尾时唯一的显式 flush 被
    // responseAlreadyRendered 门控跳过。flush 空 _remainder 是 no-op，幂等安全。
    if (streamState._streamingMd) {
      streamState._streamingMd.flush();
    }
    streamState._textBuffer = '';
    return;
  }

  const raw = streamState._textBuffer || '';
  if (!raw) {
    return;
  }

  let toRender = raw;
  let remainder = '';

  // In non-force mode (tool call about to display), keep a trailing fragment
  // so sentence halves are not printed before the continuation arrives.
  if (!force && toRender.length > 0 && !_TEXT_STRONG_BREAK_TAIL_RE.test(toRender)) {
    let splitIdx = -1;
    for (let i = toRender.length - 1; i >= 0; i--) {
      const code = toRender.charCodeAt(i);
      if (code >= 0xdc00 && code <= 0xdfff) {
        continue;
      }
      if (_TEXT_STRONG_BREAK_TAIL_RE.test(toRender[i])) {
        splitIdx = i + 1;
        break;
      }
    }
    if (splitIdx > 0) {
      remainder = toRender.slice(splitIdx);
      toRender = toRender.slice(0, splitIdx);
    } else if (toRender.length > _NONFORCE_MIN_VISIBLE_CHARS) {
      const holdChars = Math.min(
        _NONFORCE_TAIL_HOLD_CHARS,
        Math.max(8, Math.floor(toRender.length * 0.35))
      );
      splitIdx = Math.max(1, toRender.length - holdChars);
      remainder = toRender.slice(splitIdx);
      toRender = toRender.slice(0, splitIdx);
    } else {
      remainder = toRender;
      toRender = '';
    }
  }

  const buf = toRender.trim();
  streamState._textBuffer = remainder;
  if (!buf) {
    return;
  }
  _renderTextBlock(buf);
}

/**
 * Render a finalized text block with full markdown formatting.
 * Applies output limiting for very long blocks (virtual scroll substitute):
 * - Blocks under MAX_RENDER_LINES render fully
 * - Longer blocks show head + tail + fold indicator
 */
const _MAX_RENDER_LINES = 120;
const _RENDER_HEAD = 50;
const _RENDER_TAIL = 30;

function _renderTextBlock(text) {
  try {
    const renderer = require('../aiRenderer');
    const { syncWrite } = require('../syncOutput');
    const rendered = renderer.renderAiResponse(text);
    const lines = rendered.split('\n');

    if (lines.length <= _MAX_RENDER_LINES) {
      syncWrite(() => {
        lines.forEach((l) => console.log(`  ${l}`));
      });
    } else {
      // Long output: head + fold + tail (virtual scroll substitute)
      const _chalk = require('chalk').default || require('chalk');
      const headLines = lines.slice(0, _RENDER_HEAD);
      const tailLines = lines.slice(-_RENDER_TAIL);
      const folded = lines.length - _RENDER_HEAD - _RENDER_TAIL;
      syncWrite(() => {
        headLines.forEach((l) => console.log(`  ${l}`));
        console.log(`  ${_chalk.dim(`… +${folded} 行 (ctrl+o 展开)`)}`);
        tailLines.forEach((l) => console.log(`  ${l}`));
      });
      // Store for ctrl+o expansion
      try {
        renderer.pushExpandableOutput({
          tool: 'AI Response',
          detail: lines.join('\n'),
          paramStr: '',
        });
      } catch {
        /* best effort */
      }
    }
  } catch {
    console.log(`  ${text}`);
  }
}

/**
 * Check whether the incremental streaming markdown state machine is enabled.
 * Gated behind KHY_STREAMING_MD env var for safe rollout (default: enabled).
 */
function _isStreamingMdEnabled() {
  const v = String(process.env.KHY_STREAMING_MD || 'true')
    .trim()
    .toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/**
 * Create a MarkdownStreamState that feeds committed blocks into _renderTextBlock.
 * Returns null when the feature is disabled so callers can fall back.
 */
function _createStreamingMdState() {
  if (!_isStreamingMdEnabled()) {
    return null;
  }
  return new MarkdownStreamState((blockText) => {
    const trimmed = blockText.trim();
    if (trimmed) {
      _renderTextBlock(trimmed);
    }
  });
}

function closeTextStream(streamState, c) {
  flushTextBuffer(streamState, c, true);
}

const { getDisplayWidthChar, streamThinkingChunk, closeThinkingStream } = require("./thinkingRender");

module.exports = {
  mapToolToPhaseLabel,
  getDisplayWidthChar,
  streamThinkingChunk,
  closeThinkingStream,
  bufferTextChunk,
  flushTextBuffer,
  _renderTextBlock,
  _createStreamingMdState,
  closeTextStream,
};
