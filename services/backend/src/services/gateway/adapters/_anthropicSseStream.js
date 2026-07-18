'use strict';

/**
 * _anthropicSseStream.js — Unified Anthropic Messages API SSE stream parser.
 *
 * Consolidates SSE parsing logic from:
 *   - claudeAdapter.callAnthropicStream()  (~120 lines, content block array + usage)
 *   - relayApiAdapter.parseAnthropicSSEStream() (~90 lines, flat string + no usage)
 *
 * Mirrors the API surface of _openaiSseStream.js for consistency.
 *
 * Handles both SSE framing styles:
 *   - Two-line: "event: <type>\ndata: <json>"  (standard SSE spec)
 *   - Inline:   "data: {\"type\": \"<type>\", ...}"  (Anthropic shorthand)
 *
 * Dependencies: safeJsonParse (lazy), _streamStaleDetector (optional).
 */

// 瞬时 socket 报错时保全已累积 partial(纯叶子)。fail-soft:缺失则 stream.on('error')
// 逐字节回退现状 reject。门控 KHY_STREAM_ERROR_PRESERVE 默认开。
let _streamErrorPartial;
try { _streamErrorPartial = require('./streamErrorPartial'); } catch { _streamErrorPartial = null; }

// 跨 chunk 边界安全的流式 UTF-8 解码器:防中文/emoji 被劈成 U+FFFD(◆)乱码。见 _sseTextDecoder.js。
const { createSseTextDecoder } = require('./_sseTextDecoder');

/**
 * Parse an Anthropic Messages API SSE stream.
 *
 * Accumulates content blocks (text, tool_use, thinking) and emits chunks
 * via the onChunk callback for real-time streaming display.
 *
 * @param {import('stream').Readable} stream - HTTP response body stream
 * @param {function} [onChunk] - Streaming callback: ({ type, text?, name?, id?, input? }) => void
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {boolean} [options.enableToolCalls=true] - Accumulate tool_use blocks
 * @param {boolean} [options.enableThinking=true] - Extract thinking blocks
 * @param {boolean} [options.enableStaleDetection=false] - Enable stale stream detection
 * @param {object} [options.staleOptions] - Options for StreamStaleDetector
 * @returns {Promise<{ content: string, model: string|null, toolUseBlocks: Array, finishReason: string|null, usage: object|null, thinking: string|null }>}
 */
function parseAnthropicSseStream(stream, onChunk, options = {}) {
  const {
    signal = null,
    enableToolCalls = true,
    enableThinking = true,
    enableStaleDetection = false,
    staleOptions = null,
  } = options;

  return new Promise((resolve, reject) => {
    let content = '';
    let thinkingContent = '';
    let model = null;
    let finishReason = null;
    let usage = null;
    let buffer = '';
    const _textDecoder = createSseTextDecoder();
    // Terminal-marker tracking (DESIGN-ARCH-046): Anthropic always closes a
    // complete generation with a `message_delta.stop_reason` followed by
    // `message_stop`. If the socket ends WITHOUT either, the response was cut
    // off mid-stream (premature close). We must NOT coerce that to `end_turn`
    // (which masks the truncation and strands a half-sentence); instead surface
    // a truncation signal so the loop can auto-continue.
    let sawTerminal = false;

    // Current SSE event type (for two-line framing: "event: X\ndata: ...")
    let currentEventType = '';

    // Content block accumulation
    let currentBlock = null;
    const toolUseBlocks = [];
    // Structured thinking blocks (with signature) for cross-turn continuity.
    // Anthropic requires the original thinking block + its signature to be
    // echoed back in the assistant turn when extended thinking + tool use spans
    // multiple rounds. The flat `thinkingContent` string above cannot carry the
    // signature, so we accumulate structured blocks here in parallel.
    const thinkingBlocks = [];

    // Stale detection
    let staleDetector = null;
    if (enableStaleDetection && staleOptions) {
      try {
        const { StreamStaleDetector } = require('./_streamStaleDetector');
        const _stallPolicy = require('./streamStallPolicy');
        staleDetector = new StreamStaleDetector({
          ...staleOptions,
          onStale: (elapsed) => {
            if (staleOptions.onStale) staleOptions.onStale(elapsed);
            // Stalled stream → actively tear it down (single-sourced decision/error
            // in streamStallPolicy). Reuses this parser's stream.on('error')
            // partial-salvage path. Gate KHY_STREAM_STALL_ABORT off → byte-identical.
            if (_stallPolicy.shouldAbortStaleStream()) {
              try {
                stream.destroy(_stallPolicy.buildStallError({ provider: staleOptions.provider, elapsedMs: elapsed }));
              } catch { /* ignore */ }
            }
          },
        });
        staleDetector.start();
      } catch { /* stale detection unavailable */ }
    }

    // Abort handling
    if (signal) {
      if (signal.aborted) {
        if (staleDetector) staleDetector.stop();
        return reject(new DOMException('Aborted', 'AbortError'));
      }
      signal.addEventListener('abort', () => {
        if (staleDetector) staleDetector.stop();
        try { stream.destroy(); } catch { /* ignore */ }
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }

    /**
     * Resolve the event type: prefer two-line framing (currentEventType),
     * fall back to inline ev.type from the JSON payload.
     */
    function resolveEventType(ev) {
      if (currentEventType) return currentEventType;
      return ev.type || '';
    }

    /**
     * Process a single parsed SSE event object.
     */
    function processEvent(ev) {
      const eventType = resolveEventType(ev);

      switch (eventType) {
        case 'message_start': {
          const msg = ev.message || {};
          if (msg.model) model = msg.model;
          if (msg.usage) {
            usage = usage || {};
            usage.input_tokens = msg.usage.input_tokens || 0;
            // Prompt-cache billing fields live on the message_start usage block.
            // Preserve them raw so the consuming adapter can normalize (缓存计费透明探针).
            if (msg.usage.cache_read_input_tokens != null) {
              usage.cache_read_input_tokens = msg.usage.cache_read_input_tokens;
            }
            if (msg.usage.cache_creation_input_tokens != null) {
              usage.cache_creation_input_tokens = msg.usage.cache_creation_input_tokens;
            }
          }
          break;
        }

        case 'content_block_start': {
          const block = ev.content_block || {};
          currentBlock = { type: block.type, index: ev.index };
          if (block.type === 'text') {
            currentBlock.text = block.text || '';
          } else if (block.type === 'tool_use' && enableToolCalls) {
            currentBlock.id = block.id;
            currentBlock.name = block.name;
            currentBlock.inputJson = '';
          } else if (block.type === 'server_tool_use') {
            // Server-side tool (e.g. tool_search): track but don't execute locally
            currentBlock.id = block.id;
            currentBlock.name = block.name;
            currentBlock.inputJson = '';
          } else if (block.type === 'thinking' && enableThinking) {
            currentBlock.thinking = block.thinking || '';
            currentBlock.signature = block.signature || '';
          } else if (block.type === 'redacted_thinking' && enableThinking) {
            // Encrypted reasoning the model must keep but the client cannot read.
            currentBlock.data = block.data || '';
          }
          break;
        }

        case 'content_block_delta': {
          const delta = ev.delta || {};
          if (!currentBlock) break;

          if (delta.type === 'text_delta' && delta.text) {
            currentBlock.text = (currentBlock.text || '') + delta.text;
            content += delta.text;
            if (onChunk) onChunk({ type: 'text', text: delta.text });
          } else if (delta.type === 'thinking_delta' && delta.thinking && enableThinking) {
            currentBlock.thinking = (currentBlock.thinking || '') + delta.thinking;
            thinkingContent += delta.thinking;
            if (onChunk) onChunk({ type: 'thinking', text: delta.thinking });
          } else if (delta.type === 'signature_delta' && delta.signature && enableThinking) {
            // Signature for the preceding thinking block — required to echo it back.
            currentBlock.signature = (currentBlock.signature || '') + delta.signature;
          } else if (delta.type === 'input_json_delta' && delta.partial_json
            && (enableToolCalls || currentBlock.type === 'server_tool_use')) {
            currentBlock.inputJson = (currentBlock.inputJson || '') + delta.partial_json;
          }
          break;
        }

        case 'content_block_stop': {
          if (!currentBlock) break;
          if (currentBlock.type === 'tool_use' && enableToolCalls) {
            let input = {};
            if (currentBlock.inputJson) {
              try {
                input = JSON.parse(currentBlock.inputJson);
              } catch {
                try {
                  const { safeJsonParse } = require('../safeJsonParse');
                  input = safeJsonParse(currentBlock.inputJson, {});
                } catch {
                  input = {};
                }
              }
            }
            const toolBlock = {
              type: 'tool_use',
              id: currentBlock.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              name: currentBlock.name,
              input,
            };
            toolUseBlocks.push(toolBlock);
            if (onChunk) {
              onChunk({ type: 'tool_use', name: toolBlock.name, id: toolBlock.id, input });
            }
          } else if (currentBlock.type === 'server_tool_use') {
            let input = {};
            if (currentBlock.inputJson) {
              try { input = JSON.parse(currentBlock.inputJson); } catch { input = {}; }
            }
            const serverBlock = {
              type: 'server_tool_use',
              id: currentBlock.id || `stool_${Date.now()}`,
              name: currentBlock.name,
              input,
            };
            toolUseBlocks.push(serverBlock);
            if (onChunk) onChunk({ type: 'server_tool_use', name: serverBlock.name, id: serverBlock.id });
          } else if (currentBlock.type === 'thinking' && enableThinking) {
            // Preserve the structured thinking block + signature for echo-back.
            thinkingBlocks.push({
              type: 'thinking',
              thinking: currentBlock.thinking || '',
              signature: currentBlock.signature || '',
            });
          } else if (currentBlock.type === 'redacted_thinking' && enableThinking) {
            thinkingBlocks.push({ type: 'redacted_thinking', data: currentBlock.data || '' });
          }
          // text blocks are already accumulated via content
          currentBlock = null;
          break;
        }

        case 'message_delta': {
          if (ev.delta?.stop_reason) {
            finishReason = ev.delta.stop_reason;
            sawTerminal = true;
          }
          if (ev.usage) {
            usage = usage || {};
            usage.output_tokens = ev.usage.output_tokens || 0;
          }
          break;
        }

        case 'message_stop':
          // Terminal event — nothing to do; stream 'end' will resolve.
          sawTerminal = true;
          break;
      }
    }

    stream.on('data', (chunk) => {
      const raw = _textDecoder.write(chunk);
      if (staleDetector) staleDetector.touch(raw.length);

      buffer += raw;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          // Empty line resets event type in standard SSE spec
          currentEventType = '';
          continue;
        }

        // Two-line framing: "event: <type>"
        if (trimmed.startsWith('event:')) {
          currentEventType = trimmed.slice(6).trim();
          continue;
        }

        // Data line: "data: <json>"
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let ev;
          try {
            ev = JSON.parse(payload);
          } catch {
            try {
              const { safeJsonParse } = require('../safeJsonParse');
              ev = safeJsonParse(payload, null);
            } catch { continue; }
            if (!ev) continue;
          }

          processEvent(ev);
          currentEventType = '';
        }
      }
    });

    stream.on('error', (err) => {
      if (staleDetector) staleDetector.stop();
      // 瞬时传输错误且已吐出 partial:对齐 premature-close,把已产出文本作为截断
      // ('length')交还,喂给 maxTokensRecovery 续写路径,而非整段丢弃。门控关 / 非瞬时
      // / 无内容 / 用户中止 → 逐字节回退原 reject(err)。
      try {
        if (_streamErrorPartial
          && _streamErrorPartial.shouldPreservePartial({ error: err, hasContent: !!content }, process.env)) {
          resolve({
            content,
            model,
            toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : [],
            finishReason: 'length',
            usage,
            thinking: thinkingContent || null,
            thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : [],
          });
          return;
        }
      } catch { /* fall through to reject */ }
      reject(err);
    });

    stream.on('end', () => {
      if (staleDetector) staleDetector.stop();

      // 冲刷解码器残字节(拼齐最后一个多字节字符);上游中途截断则残留 U+FFFD(不可救)。
      const _tail = _textDecoder.end();
      if (_tail) buffer += _tail;

      // Process remaining buffer
      if (buffer.trim()) {
        const remaining = buffer.trim();
        if (remaining.startsWith('data:')) {
          const payload = remaining.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            try {
              const ev = JSON.parse(payload);
              processEvent(ev);
            } catch { /* ignore trailing garbage */ }
          }
        }
      }

      // Premature-close detection (DESIGN-ARCH-046): the socket ended without
      // any terminal marker (no message_delta.stop_reason, no message_stop).
      // With partial content already accumulated, this is a mid-stream cut-off,
      // not a clean end. Surface it as a truncation ('length') so the tool loop
      // auto-continues from the partial text instead of finalizing a half
      // sentence as a complete answer. We only override when there is content
      // AND no explicit stop_reason arrived — a clean stream keeps end_turn and
      // pays zero behavioral cost.
      if (!sawTerminal && !finishReason && content) {
        finishReason = 'length';
      }

      resolve({
        content,
        model,
        toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : [],
        finishReason: finishReason || 'end_turn',
        usage,
        thinking: thinkingContent || null,
        thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : [],
      });
    });
  });
}

module.exports = {
  parseAnthropicSseStream,
};
