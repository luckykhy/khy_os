'use strict';

/**
 * _openaiSseStream.js — Unified OpenAI-compatible SSE stream parser.
 *
 * Consolidates SSE parsing logic from:
 *   - relayApiAdapter.parseSSEStream() (207 lines, full tool call support)
 *   - cursor2apiAdapter.parseSSEStream() (36 lines, text-only)
 *
 * Configurable:
 *   - enableToolCalls: accumulate streaming tool_calls (OpenAI format)
 *   - enableStaleDetection: attach StreamStaleDetector
 *   - enableThinking: extract reasoning_content/thinking fields
 *
 * Phase 3A of industrial-grade modularization.
 * Dependencies: _streamStaleDetector (optional), safeJsonParse (lazy).
 */

// 跨 chunk 边界安全的流式 UTF-8 解码器:防中文/emoji 被劈成 U+FFFD(◆)乱码。见 _sseTextDecoder.js。
const { createSseTextDecoder } = require('./_sseTextDecoder');

/**
 * Parse an OpenAI-compatible SSE stream.
 *
 * @param {import('stream').Readable} stream - HTTP response body stream
 * @param {function} [onChunk] - Streaming callback: ({ type, text?, name?, id? }) => void
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {boolean} [options.enableToolCalls=true] - Accumulate streaming tool calls
 * @param {boolean} [options.enableThinking=true] - Extract thinking/reasoning content
 * @param {boolean} [options.enableStaleDetection=false] - Enable stale stream detection
 * @param {object} [options.staleOptions] - Options for StreamStaleDetector
 * @returns {Promise<{ content: string, thinking: string, model: string|null, toolUseBlocks: Array, finishReason: string|null, usage: object|null, interrupted?: boolean, interruptError?: string }>}
 */
function parseOpenAISseStream(stream, onChunk, options = {}) {
  const {
    signal = null,
    enableToolCalls = true,
    enableThinking = true,
    enableStaleDetection = false,
    staleOptions = null,
  } = options;

  return new Promise((resolve, reject) => {
    let content = '';
    // Accumulate reasoning/thinking text. Reasoning-capable models (e.g.
    // deepseek-v4) may emit ONLY reasoning_content with an empty `content`;
    // dropping it (as before) turned such a turn into a bare empty reply →
    // the user-facing "未返回有效回复". We accumulate it and return it so the
    // consumer can route the turn into continuation recovery instead. Mirrors
    // the non-streaming JSON path (_protocolPipeline.parseJsonResponse), which
    // already returns `thinking`.
    let thinking = '';
    let model = null;
    let finishReason = null;
    let usage = null;
    let buffer = '';
    const _textDecoder = createSseTextDecoder();

    // Count SSE lines where both JSON.parse and safeJsonParse failed (Task 6).
    // Attached to the end-path result for upstream observability.
    let _parseFailCount = 0;

    // Tool call accumulator: Map<index, { id, name, arguments }>
    const toolCallAccum = enableToolCalls ? new Map() : null;

    // Track whether the stream was actively interrupted (stale detector or abort)
    // vs a clean close. Only force truncation on actual interruption.
    let _interrupted = false;

    // Stale detection
    let staleDetector = null;
    if (enableStaleDetection && staleOptions) {
      try {
        const { StreamStaleDetector } = require('./_streamStaleDetector');
        const _stallPolicy = require('./streamStallPolicy');
        staleDetector = new StreamStaleDetector({
          ...staleOptions,
          onStale: (elapsed) => {
            if (staleOptions.onStale) {
              staleOptions.onStale(elapsed);
            }
            if (_stallPolicy.shouldAbortStaleStream()) {
              _interrupted = true;
              try {
                stream.destroy(
                  _stallPolicy.buildStallError({
                    provider: staleOptions.provider,
                    elapsedMs: elapsed,
                  })
                );
              } catch {
                /* ignore */
              }
            }
          },
        });
        staleDetector.start();
      } catch {
        /* stale detection unavailable */
      }
    }

    // Abort handling
    if (signal) {
      if (signal.aborted) {
        if (staleDetector) {
          staleDetector.stop();
        }
        return reject(new DOMException('Aborted', 'AbortError'));
      }
      signal.addEventListener(
        'abort',
        () => {
          if (staleDetector) {
            staleDetector.stop();
          }
          _interrupted = true;
          try {
            stream.destroy();
          } catch {
            /* ignore */
          }
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    }

    // Finalize accumulated streaming tool_calls into Anthropic-shaped blocks.
    // Shared by the `end` and `error` (partial-salvage) paths.
    const _finalizeToolUseBlocks = () => {
      const blocks = [];
      if (!enableToolCalls || !toolCallAccum || toolCallAccum.size === 0) {
        return blocks;
      }
      const sorted = [...toolCallAccum.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, tc] of sorted) {
        let input = {};
        if (tc.arguments) {
          try {
            input = JSON.parse(tc.arguments);
          } catch {
            // Try safe JSON parse for truncated arguments
            try {
              const { safeJsonParse } = require('../safeJsonParse');
              input = safeJsonParse(tc.arguments, {});
            } catch {
              input = {};
            }
          }
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: tc.name,
          input,
        });
      }
      return blocks;
    };

    // Self-heal: consumer onChunk callback must not kill the stream pipeline
    const _safeOnChunk = (chunk) => {
      try {
        if (typeof onChunk === 'function') {
          onChunk(chunk);
        }
      } catch {
        /* consumer error — swallow to protect stream integrity */
      }
    };

    stream.on('data', (chunk) => {
      const raw = _textDecoder.write(chunk);
      if (staleDetector) {
        staleDetector.touch(raw.length);
      }

      buffer += raw;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          continue;
        }

        let obj;
        try {
          obj = JSON.parse(payload);
        } catch {
          // Try safe JSON parse for truncated payloads
          try {
            const { safeJsonParse } = require('../safeJsonParse');
            obj = safeJsonParse(payload, null);
          } catch {
            _parseFailCount++;
            continue;
          }
          if (!obj) {
            _parseFailCount++;
            continue;
          }
        }

        // Extract model
        if (obj.model && !model) {
          model = obj.model;
        }

        // Extract usage (some providers send it in the final chunk)
        if (obj.usage) {
          usage = obj.usage;
        }

        const choice = obj.choices?.[0];
        if (!choice) {
          // Anthropic-format fallback: content_block_delta
          if (obj.type === 'content_block_delta' && obj.delta?.text) {
            content += obj.delta.text;
            if (onChunk) {
              _safeOnChunk({ type: 'text', text: obj.delta.text });
            }
          }
          // OpenAI Responses API fallback: relay proxies may transparently
          // forward /v1/responses SSE events through a /v1/chat/completions
          // endpoint. Handle the most common Responses event types so content
          // is not silently lost (fixes empty-reply for gpt-5.x-codex models).
          else if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') {
            content += obj.delta;
            if (onChunk) {
              _safeOnChunk({ type: 'text', text: obj.delta });
            }
          } else if (
            obj.type === 'response.reasoning_summary_text.delta' &&
            typeof obj.delta === 'string'
          ) {
            if (enableThinking) {
              thinking += obj.delta;
              if (onChunk) {
                _safeOnChunk({ type: 'thinking', text: obj.delta });
              }
            }
          } else if (obj.type === 'response.output_item.added' && obj.item) {
            // Function-call item opens: capture name + id
            if (obj.item.type === 'function_call' && enableToolCalls && toolCallAccum) {
              const fcIdx = obj.item.output_index ?? toolCallAccum.size;
              if (!toolCallAccum.has(fcIdx)) {
                toolCallAccum.set(fcIdx, {
                  id: obj.item.call_id || obj.item.id || '',
                  name: obj.item.name || '',
                  arguments: '',
                });
              }
              if (onChunk && obj.item.name) {
                _safeOnChunk({
                  type: 'tool_use',
                  name: obj.item.name,
                  id: obj.item.call_id || obj.item.id || '',
                });
              }
            }
          } else if (
            obj.type === 'response.function_call_arguments.delta' &&
            enableToolCalls &&
            toolCallAccum
          ) {
            // Accumulate function-call argument fragments
            const fcEntry =
              toolCallAccum.get(obj.output_index ?? 0) || [...toolCallAccum.values()].pop();
            if (fcEntry && typeof obj.delta === 'string') {
              fcEntry.arguments += obj.delta;
            }
          } else if (
            (obj.type === 'response.completed' ||
              obj.type === 'response.in_progress' ||
              obj.type === 'response.created') &&
            obj.response
          ) {
            if (obj.response.model && !model) {
              model = obj.response.model;
            }
            if (obj.response.usage) {
              usage = obj.response.usage;
            }
            if (obj.type === 'response.completed') {
              finishReason =
                obj.response.status === 'completed' ? 'stop' : obj.response.status || 'stop';
            }
          }
          continue;
        }

        const delta = choice.delta;
        if (!delta) {
          continue;
        }

        // Extract finish_reason
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        // Text content
        const textContent = delta.content;
        if (typeof textContent === 'string' && textContent) {
          content += textContent;
          if (onChunk) {
            _safeOnChunk({ type: 'text', text: textContent });
          }
        }

        // Thinking/reasoning content
        if (enableThinking) {
          const thinkChunk = delta.reasoning_content || delta.thinking;
          if (typeof thinkChunk === 'string' && thinkChunk) {
            thinking += thinkChunk;
            if (onChunk) {
              _safeOnChunk({ type: 'thinking', text: thinkChunk });
            }
          }
        }

        // Streaming tool calls (OpenAI format)
        if (enableToolCalls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, { id: '', name: '', arguments: '' });
            }
            const accum = toolCallAccum.get(idx);
            if (tc.id) {
              accum.id = tc.id;
            }
            if (tc.function?.name) {
              accum.name += tc.function.name;
            }
            if (tc.function?.arguments) {
              accum.arguments += tc.function.arguments;
            }

            if (onChunk && tc.function?.name) {
              _safeOnChunk({ type: 'tool_use', name: tc.function.name, id: tc.id || accum.id });
            }
          }
        }
      }
    });

    stream.on('error', (err) => {
      if (staleDetector) {
        staleDetector.stop();
      }
      // Transient channel interruption (ECONNRESET / premature close) must NOT
      // discard work already streamed to the user. If any content or tool call
      // was accumulated, resolve with the PARTIAL result tagged interrupted so
      // the upstream continuation/maxTokens recovery can resume from it rather
      // than regenerating from scratch (the "半截话" data-loss symptom). Aborts
      // are an explicit user action and still reject. A zero-progress error has
      // nothing to salvage and rejects so the caller can classify it.
      const aborted = err && (err.name === 'AbortError' || (signal && signal.aborted));
      const hasProgress = !!content || (toolCallAccum && toolCallAccum.size > 0);
      if (!aborted && hasProgress) {
        _interrupted = true;
        resolve({
          content,
          thinking,
          model,
          toolUseBlocks: _finalizeToolUseBlocks(),
          // Mark as interrupted (not 'length') so the upstream can distinguish
          // network-truncated partial salvage from a genuine max_tokens cutoff.
          // Auto-continue is suppressed for interrupted results (Task 3).
          finishReason: 'interrupted',
          usage,
          interrupted: true,
          interruptError: err && err.message ? String(err.message) : 'stream error',
        });
        return;
      }
      reject(err);
    });

    stream.on('end', () => {
      if (staleDetector) {
        staleDetector.stop();
      }

      // 冲刷解码器残字节(拼齐最后一个多字节字符);上游中途截断则残留 U+FFFD(不可救)。
      const _tail = _textDecoder.end();
      if (_tail) {
        buffer += _tail;
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const remaining = buffer.trim();
        if (remaining.startsWith('data:')) {
          const payload = remaining.slice(5).trim();
          if (payload && payload !== '[DONE]') {
            try {
              const obj = JSON.parse(payload);
              const textContent = obj.choices?.[0]?.delta?.content;
              if (typeof textContent === 'string') {
                content += textContent;
              }
              if (obj.choices?.[0]?.finish_reason) {
                finishReason = obj.choices[0].finish_reason;
              }
              if (obj.usage) {
                usage = obj.usage;
              }
            } catch {
              /* ignore trailing garbage */
            }
          }
        }
      }

      // Finalize tool use blocks
      const toolUseBlocks = _finalizeToolUseBlocks();

      // Stream ended without an explicit finish_reason. If the stream was
      // ACTIVELY interrupted (stale detector or abort), tag as 'interrupted'
      // (not 'length') so upstream auto-continue is suppressed and a network-
      // interruption hint is shown instead (Task 3). A clean end where a relay
      // proxy stripped the finish_reason should NOT be flagged — the response
      // is likely complete.
      if (_interrupted && !finishReason && content && toolUseBlocks.length === 0) {
        finishReason = 'interrupted';
      }

      resolve({
        content,
        thinking,
        model,
        toolUseBlocks,
        finishReason,
        usage,
        parseFailures: _parseFailCount,
        interrupted: _interrupted,
      });
    });
  });
}

module.exports = {
  parseOpenAISseStream,
};
