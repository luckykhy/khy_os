'use strict';

/**
 * streamRender — trailing-sentence flush regression (node:test).
 *
 * Reproduces the "last sentence cut off" bug: the streamed AI answer's final
 * line usually has no trailing "\n", so AdaptiveChunker.flushAll() feeds it into
 * MarkdownStreamState where feed() parks it in _remainder. Only flush() emits
 * _remainder. A force flush (stream/segment end) must therefore also flush the
 * streaming-markdown state, or the last sentence is silently dropped — most
 * visibly on multi-iteration agentic turns where the one explicit flush is
 * gated out by responseAlreadyRendered.
 *
 * The renderer writes through console.log (via syncOutput); we capture it.
 * Deterministic: no network, no real model, KHY_STREAMING_MD forced on.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.KHY_STREAMING_MD = 'true';

const { LineBuffer, AdaptiveChunker } = require('../../src/cli/lineBuffer');
const streamRender = require('../../src/cli/repl/streamRender');

// Build a streamState wired exactly like repl.js (chunker → streamingMd.feed).
function makeStreamState() {
  const s = {};
  s._streamingMd = streamRender._createStreamingMdState();
  s._lineBuffer = new LineBuffer();
  s._chunker = new AdaptiveChunker(s._lineBuffer, (text) => {
    if (s._streamingMd) s._streamingMd.feed(text);
  });
  s._textBuffer = '';
  return s;
}

function captureConsole(fn) {
  const chunks = [];
  const orig = console.log;
  console.log = (...args) => { chunks.push(args.join(' ')); };
  try { fn(); } finally { console.log = orig; }
  return chunks.join('\n');
}

// The renderer soft-wraps long lines to the terminal width (inserting "\n  ").
// Flatten that wrapping so assertions test content, not line geometry.
function flatten(out) {
  return out.replace(/\n\s*/g, '');
}

test('force flush emits the trailing un-newlined sentence (no tail drop)', () => {
  const s = makeStreamState();
  // A complete line, then a final sentence WITHOUT a trailing newline — the
  // exact shape that used to be dropped.
  const out = captureConsole(() => {
    streamRender.bufferTextChunk('第一行内容\n', s);
    streamRender.bufferTextChunk('DeepSeek 模型在 Claude Code 中无法使用，因为 Claude Code 是 Anthropic 的封闭产品。', s);
    streamRender.flushTextBuffer(s, () => ({}), true); // force flush == stream/segment end
  });
  const flat = flatten(out);
  assert.match(flat, /Anthropic 的封闭产品。/, 'trailing sentence must be rendered, not parked in _remainder');
  assert.match(flat, /第一行内容/);
});

test('closeTextStream also flushes the streaming-markdown remainder', () => {
  const s = makeStreamState();
  const out = captureConsole(() => {
    streamRender.bufferTextChunk('只有一句没有换行结尾', s);
    streamRender.closeTextStream(s, () => ({}));
  });
  assert.match(flatten(out), /只有一句没有换行结尾/);
});

test('force flush is idempotent — second flush emits nothing (empty _remainder)', () => {
  const s = makeStreamState();
  const first = captureConsole(() => {
    streamRender.bufferTextChunk('内容尾句无换行', s);
    streamRender.flushTextBuffer(s, () => ({}), true);
  });
  assert.match(flatten(first), /内容尾句无换行/);
  const second = captureConsole(() => {
    streamRender.flushTextBuffer(s, () => ({}), true);
  });
  assert.equal(second.trim(), '', 'a second force flush must be a no-op (no duplicate tail)');
});
