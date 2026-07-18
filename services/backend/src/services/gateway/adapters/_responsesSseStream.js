'use strict';

/**
 * _responsesSseStream.js — OpenAI Responses API (`/v1/responses`) SSE stream parser.
 *
 * The outbound counterpart to proxyServer's inbound Responses streaming: when
 * KhyOS is the CLIENT of a Responses-API upstream, this consumes the named-event
 * SSE stream and reduces it to the same `{ content, model, toolUseBlocks,
 * finishReason, usage }` shape the OpenAI/Anthropic handlers return, so the
 * relay adapter is protocol-agnostic downstream.
 *
 * Event model (data lines only — the `event:` line is redundant and ignored):
 *   response.created / response.in_progress  → carry the response snapshot (id/model)
 *   response.output_item.added (message)     → a text item opens
 *   response.output_text.delta               → { item_id, delta } text fragment
 *   response.output_item.added (function_call)→ { item:{ id:'fc_…', call_id:'call_…', name } }
 *   response.function_call_arguments.delta    → { item_id, delta } JSON-string fragment
 *   response.function_call_arguments.done     → { item_id, arguments } (name is often null here — ignore it)
 *   response.output_item.done                 → item finalized
 *   response.completed                        → { response:{ status, usage, output } } TERMINAL (no [DONE])
 *
 * Tool accumulation is keyed by `item_id` (the `fc_…` id), NOT `call_id`: arg
 * deltas reference item_id, while the emitted tool_use block carries `call_id`
 * (what the upstream expects back as `function_call_output`). `arguments` is
 * always a JSON string; we JSON.parse it once at the end.
 *
 * Dependencies: _responsesFormat (completed-snapshot fallback), safeJsonParse (lazy).
 */

// 跨 chunk 边界安全的流式 UTF-8 解码器:防中文/emoji 被劈成 U+FFFD(◆)乱码。见 _sseTextDecoder.js。
const { createSseTextDecoder } = require('./_sseTextDecoder');

/**
 * Parse an OpenAI Responses API SSE stream.
 *
 * @param {import('stream').Readable} stream - HTTP response body stream
 * @param {function} [onChunk] - Streaming callback: ({ type, text?, name?, id?, partialJson? }) => void
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {boolean} [options.enableToolCalls=true] - Accumulate streaming function calls
 * @param {boolean} [options.enableThinking=true] - Surface reasoning deltas
 * @param {boolean} [options.enableStaleDetection=false] - Enable stale stream detection
 * @param {object} [options.staleOptions] - Options for StreamStaleDetector
 * @returns {Promise<{ content: string, model: string|null, toolUseBlocks: Array, finishReason: string|null, usage: object|null }>}
 */
function parseResponsesSseStream(stream, onChunk, options = {}) {
  const {
    signal = null,
    enableToolCalls = true,
    enableThinking = true,
    enableStaleDetection = false,
    staleOptions = null,
  } = options;

  return new Promise((resolve, reject) => {
    let content = '';
    let model = null;
    let finishReason = null;
    let usage = null;
    let buffer = '';
    let completedSnapshot = null;
    const _textDecoder = createSseTextDecoder();

    // Function-call accumulator: Map<item_id, { itemId, callId, name, arguments, order }>
    const toolAccum = enableToolCalls ? new Map() : null;
    let toolOrder = 0;

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

    const parsePayload = (payload) => {
      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        try {
          const { safeJsonParse } = require('../safeJsonParse');
          obj = safeJsonParse(payload, null);
        } catch { return; }
        if (!obj) return;
      }
      handleEvent(obj);
    };

    const handleEvent = (ev) => {
      const type = ev && ev.type;
      if (!type) return;

      switch (type) {
        case 'response.created':
        case 'response.in_progress':
        case 'response.completed':
        case 'response.failed':
        case 'response.incomplete': {
          const snap = ev.response;
          if (snap && typeof snap === 'object') {
            if (snap.model && !model) model = snap.model;
            if (snap.usage) usage = snap.usage;
            if (snap.status) finishReason = snap.status;
            if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
              completedSnapshot = snap;
            }
          }
          break;
        }

        case 'response.output_text.delta': {
          const text = typeof ev.delta === 'string' ? ev.delta : '';
          if (text) {
            content += text;
            if (onChunk) onChunk({ type: 'text', text });
          }
          break;
        }

        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          if (enableThinking) {
            const text = typeof ev.delta === 'string' ? ev.delta : '';
            if (text && onChunk) onChunk({ type: 'thinking', text });
          }
          break;
        }

        case 'response.output_item.added': {
          const item = ev.item || {};
          if (enableToolCalls && item.type === 'function_call') {
            const itemId = item.id || ev.item_id || `fc_${toolOrder}`;
            if (!toolAccum.has(itemId)) {
              toolAccum.set(itemId, {
                itemId,
                callId: item.call_id || itemId,
                name: item.name || '',
                arguments: typeof item.arguments === 'string' ? item.arguments : '',
                order: toolOrder++,
              });
            }
            const accum = toolAccum.get(itemId);
            if (onChunk) onChunk({ type: 'tool_use_start', id: accum.callId, name: accum.name });
          }
          break;
        }

        case 'response.function_call_arguments.delta': {
          if (enableToolCalls) {
            const itemId = ev.item_id;
            const frag = typeof ev.delta === 'string' ? ev.delta : '';
            if (itemId && toolAccum.has(itemId) && frag) {
              toolAccum.get(itemId).arguments += frag;
              if (onChunk) onChunk({ type: 'tool_use_input_delta', partialJson: frag });
            }
          }
          break;
        }

        case 'response.function_call_arguments.done': {
          // The terminal `arguments` string; trust the accumulated buffer but
          // adopt the full value if we somehow missed deltas. `name` here is
          // frequently null (SDK quirk) — never overwrite the added-event name.
          if (enableToolCalls) {
            const itemId = ev.item_id;
            const accum = itemId && toolAccum.get(itemId);
            if (accum && typeof ev.arguments === 'string' && ev.arguments && !accum.arguments) {
              accum.arguments = ev.arguments;
            }
            if (accum && onChunk) onChunk({ type: 'tool_use_end' });
          }
          break;
        }

        case 'response.output_item.done': {
          // Item finalized. For function_call items, reconcile the final shape.
          if (enableToolCalls && ev.item && ev.item.type === 'function_call') {
            const itemId = ev.item.id || ev.item_id;
            const accum = itemId && toolAccum.get(itemId);
            if (accum) {
              if (ev.item.call_id) accum.callId = ev.item.call_id;
              if (ev.item.name) accum.name = ev.item.name;
              if (typeof ev.item.arguments === 'string' && ev.item.arguments && !accum.arguments) {
                accum.arguments = ev.item.arguments;
              }
            }
          }
          break;
        }

        default:
          break;
      }
    };

    stream.on('data', (chunk) => {
      const raw = _textDecoder.write(chunk);
      if (staleDetector) staleDetector.touch(raw.length);

      buffer += raw;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        // Responses streams interleave `event:` and `data:` lines; only data carries JSON.
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue; // [DONE] is not part of the Responses spec, tolerate it
        parsePayload(payload);
      }
    });

    stream.on('error', (err) => {
      if (staleDetector) staleDetector.stop();
      reject(err);
    });

    stream.on('end', () => {
      if (staleDetector) staleDetector.stop();

      // 冲刷解码器残字节(拼齐最后一个多字节字符);上游中途截断则残留 U+FFFD(不可救)。
      const _tail = _textDecoder.end();
      if (_tail) buffer += _tail;

      // Flush a trailing buffered data line, if any.
      if (buffer.trim().startsWith('data:')) {
        const payload = buffer.trim().slice(5).trim();
        if (payload && payload !== '[DONE]') parsePayload(payload);
      }

      // Build tool_use blocks from the accumulator (ordered by appearance).
      let toolUseBlocks = [];
      if (enableToolCalls && toolAccum && toolAccum.size > 0) {
        const sorted = [...toolAccum.values()].sort((a, b) => a.order - b.order);
        toolUseBlocks = sorted.map((t) => {
          let input = {};
          if (t.arguments) {
            try {
              input = JSON.parse(t.arguments);
            } catch {
              try {
                const { safeJsonParse } = require('../safeJsonParse');
                input = safeJsonParse(t.arguments, {});
              } catch { input = {}; }
            }
          }
          return { type: 'tool_use', id: t.callId, name: t.name || 'unknown', input };
        });
      }

      // Fallback: a provider that only sent response.completed (no deltas).
      if (!content && toolUseBlocks.length === 0 && completedSnapshot && Array.isArray(completedSnapshot.output)) {
        try {
          const { parseDirectResponse } = require('./_responsesFormat');
          const { textParts, functionCalls } = parseDirectResponse(completedSnapshot.output);
          content = textParts.join('\n').trim();
          toolUseBlocks = functionCalls.map((fc) => {
            let input = {};
            try { input = JSON.parse(fc.arguments); } catch { input = {}; }
            return { type: 'tool_use', id: fc.call_id, name: fc.name, input };
          });
        } catch { /* snapshot malformed — leave as-is */ }
      }

      // Normalize finish reason: a tool call means the upstream awaits action.
      const normalizedFinish = toolUseBlocks.length > 0
        ? 'tool_use'
        : (finishReason === 'completed' ? 'stop' : (finishReason || 'stop'));

      resolve({ content, model, toolUseBlocks, finishReason: normalizedFinish, usage });
    });
  });
}

module.exports = {
  parseResponsesSseStream,
};
