'use strict';

/**
 * _cwStreamParser.js -- Shared CodeWhisperer (CW) protocol utilities.
 *
 * Extracted from kiroAdapter.js to be reused by kiro, trae, and any future
 * adapter that speaks the AWS Q Developer GenerateAssistantResponse protocol.
 *
 * Provides:
 *   - getCWModule()              -- lazy-load @aws/codewhisperer-streaming-client (ESM)
 *   - repairToolUsePairing()     -- fix unpaired tool_use/tool_result in message arrays
 *   - parseCWStreamEvents()      -- consume GenerateAssistantResponse async-iterable events
 */

let _cwModule = null;

/**
 * Lazily load the @aws/codewhisperer-streaming-client ESM module.
 * Caches the result for subsequent calls.
 *
 * @returns {Promise<object>} The CW streaming client module
 * @throws {Error} If the package is not installed
 */
async function getCWModule() {
  if (_cwModule) return _cwModule;
  try {
    _cwModule = await import('@aws/codewhisperer-streaming-client');
  } catch (err) {
    throw new Error(
      'CW SDK not installed. Run: cd backend && npm install @aws/codewhisperer-streaming-client'
    );
  }
  return _cwModule;
}

/**
 * Reset the cached CW module (used by destroy() in adapters).
 */
function resetCWModuleCache() {
  _cwModule = null;
}

/**
 * Repair unpaired tool_use/tool_result blocks in a messages array.
 *
 * Bedrock/Anthropic API requires that every assistant message containing
 * tool_use blocks is immediately followed by a user message with matching
 * tool_result blocks. If this invariant is violated (e.g., because the
 * conversation was truncated, a tool execution was interrupted, or the
 * client session state was corrupted), the API returns a hard error.
 *
 * This function scans the messages and degrades any unpaired tool_use
 * blocks in assistant messages to plain text descriptions, preserving
 * the conversation flow without breaking the API contract.
 *
 * @param {Array} messages - Anthropic-format messages array
 * @returns {Array} Repaired messages (shallow copy; originals not mutated)
 */
function repairToolUsePairing(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // Work on a shallow copy to avoid mutating the original
  const repaired = messages.map(m => ({ ...m }));

  for (let i = 0; i < repaired.length; i++) {
    const msg = repaired[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    // Collect tool_use IDs in this assistant message
    const toolUseIds = new Set();
    for (const block of msg.content) {
      if (block && block.type === 'tool_use' && block.id) {
        toolUseIds.add(block.id);
      }
    }
    if (toolUseIds.size === 0) continue;

    // Check the next message for matching tool_result blocks
    const next = repaired[i + 1];
    const resultIds = new Set();
    if (next && Array.isArray(next.content)) {
      for (const block of next.content) {
        if (block && block.type === 'tool_result' && block.tool_use_id) {
          resultIds.add(block.tool_use_id);
        }
      }
    }

    // Check if all tool_use IDs have matching tool_result
    let allMatched = true;
    for (const id of toolUseIds) {
      if (!resultIds.has(id)) { allMatched = false; break; }
    }

    if (!allMatched) {
      // Degrade tool_use blocks to text descriptions, keep text blocks
      const textParts = [];
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          const inputStr = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
          textParts.push(`[Called tool: ${block.name || 'unknown'}${inputStr ? ` with ${inputStr}` : ''}]`);
        }
      }
      repaired[i] = {
        ...msg,
        content: textParts.join('\n') || '[assistant response]',
      };

      // Also remove orphan tool_result blocks from the next message
      // to avoid "tool_result without preceding tool_use" errors
      if (next && Array.isArray(next.content)) {
        const filtered = next.content.filter(b => {
          if (b.type !== 'tool_result') return true;
          return !toolUseIds.has(b.tool_use_id);
        });
        // If only tool_results remain and all were removed, keep text or set fallback
        if (filtered.length === 0) {
          repaired[i + 1] = { ...next, content: '[tool results unavailable]' };
        } else if (filtered.length !== next.content.length) {
          repaired[i + 1] = { ...next, content: filtered };
        }
      }
    }
  }

  return repaired;
}

/**
 * Parse CW SDK streaming response events from GenerateAssistantResponse.
 *
 * Consumes the full async-iterable event stream and returns the accumulated
 * result. Calls onChunk for each incremental chunk so callers can relay
 * content to the user in real time.
 *
 * @param {AsyncIterable} eventStream - The generateAssistantResponseResponse async iterable
 * @param {function} [onChunk] - Callback for text/thinking/tool_use chunks
 *   Called with objects like:
 *     { type: 'text', text }
 *     { type: 'thinking', text }
 *     { type: 'thinking_signature', signature }
 *     { type: 'token_usage', inputTokens, outputTokens, ... }
 *     { type: 'tool_use_start', toolUseId, name }
 *     { type: 'tool_use_input_delta', toolUseId, partialJson }
 *     { type: 'tool_use_end', toolUseId, name, input }
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - Abort signal
 * @returns {Promise<{ content: string, modelId: string|null, tokenUsage: object|null, toolUseBlocks: Array, thinking: string }>}
 */
async function parseCWStreamEvents(eventStream, onChunk, opts = {}) {
  const _onChunk = typeof onChunk === 'function' ? onChunk : () => {};

  let content = '';
  let modelId = null;
  let tokenUsage = null;
  let thinking = '';
  const activeToolUses = new Map(); // toolUseId -> { name, inputChunks }
  const toolUseBlocks = [];

  // Process a single CW event into the accumulators. Extracted so the gate-off
  // path keeps the literal `for await` loop (byte-identical to pre-change) while
  // the gate-on path drives the iterator manually to race it against a stall
  // timer — no event-handling logic is duplicated across the two paths.
  const processEvent = (event) => {
    // Text content
    if (event.assistantResponseEvent?.content) {
      const text = event.assistantResponseEvent.content;
      content += text;
      if (event.assistantResponseEvent.modelId) {
        modelId = event.assistantResponseEvent.modelId;
      }
      _onChunk({ type: 'text', text });
    }

    // Thinking/reasoning content
    if (event.reasoningContentEvent?.text) {
      thinking += event.reasoningContentEvent.text;
      _onChunk({ type: 'thinking', text: event.reasoningContentEvent.text });
    }
    if (event.reasoningContentEvent?.signature) {
      _onChunk({ type: 'thinking_signature', signature: event.reasoningContentEvent.signature });
    }

    // Metering event (must consume to advance stream)
    if (event.meteringEvent) { /* consumed */ }

    // Code reference event
    if (event.codeReferenceEvent) { /* consumed */ }

    // Context usage event
    if (event.contextUsageEvent) { /* consumed */ }

    // Supplementary links
    if (event.supplementaryWebLinksEvent) { /* consumed */ }

    // Token usage metadata
    if (event.metadataEvent?.tokenUsage) {
      const t = event.metadataEvent.tokenUsage;
      tokenUsage = {
        inputTokens: t.uncachedInputTokens ?? 0,
        outputTokens: t.outputTokens ?? 0,
        cacheReadInputTokens: t.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: t.cacheWriteInputTokens ?? 0,
        totalTokens: t.totalTokens ?? 0,
      };
      _onChunk({ type: 'token_usage', ...tokenUsage });
    }

    // Invalid state (error from Q Developer)
    if (event.invalidStateEvent) {
      const reason = event.invalidStateEvent.reason || 'unknown';
      const message = event.invalidStateEvent.message || '';
      throw new Error(`Q Developer error: ${reason} -- ${message}`);
    }

    // Tool use events -- incremental emit for proxyServer SSE reconstruction
    if (event.toolUseEvent) {
      const { toolUseId, name, input, stop } = event.toolUseEvent;

      if (toolUseId && name && !activeToolUses.has(toolUseId)) {
        activeToolUses.set(toolUseId, { name, inputChunks: [] });
        _onChunk({ type: 'tool_use_start', toolUseId, name });
      }

      if (toolUseId && input) {
        const tool = activeToolUses.get(toolUseId);
        if (tool) {
          tool.inputChunks.push(input);
          _onChunk({ type: 'tool_use_input_delta', toolUseId, partialJson: input });
        }
      }

      if (stop) {
        for (const [id, tool] of activeToolUses) {
          let parsedInput = {};
          const raw = tool.inputChunks.join('');
          if (raw) {
            try { parsedInput = JSON.parse(raw); } catch { parsedInput = { raw }; }
          }
          const block = { type: 'tool_use', id, name: tool.name, input: parsedInput };
          toolUseBlocks.push(block);
          _onChunk({ type: 'tool_use_end', toolUseId: id, name: tool.name, input: parsedInput });
        }
        activeToolUses.clear();
      }
    }
  };

  // Force-close any unclosed tool_use blocks (stream end or stall salvage).
  const flushOpenToolUses = () => {
    for (const [id, tool] of activeToolUses) {
      let parsedInput = {};
      const raw = tool.inputChunks.join('');
      if (raw) {
        try { parsedInput = JSON.parse(raw); } catch { parsedInput = { raw }; }
      }
      const block = { type: 'tool_use', id, name: tool.name, input: parsedInput };
      toolUseBlocks.push(block);
      _onChunk({ type: 'tool_use_end', toolUseId: id, name: tool.name, input: parsedInput });
    }
    activeToolUses.clear();
  };

  // ── Stale-stream teardown (single-sourced in streamStallPolicy; provider-aware
  // threshold from StreamStaleDetector). CW is an async-iterable, not a Node
  // stream, so we cannot `stream.destroy()` — instead we race iterator.next()
  // against a stall signal. On stall WITH progress we resolve the partial result
  // (mirrors the SSE parsers' interrupted/length salvage so kiro/trae recover the
  // half-answer); zero-progress stall throws a timeout-classified stall error →
  // gateway retry/failover. Gate KHY_STREAM_STALL_ABORT off (or caller did not
  // opt in) → the plain `for await` path below runs, byte-identical to before. ──
  let _stallPolicy = null;
  try { _stallPolicy = require('./streamStallPolicy'); } catch { _stallPolicy = null; }
  const _staleEnabled = !!(
    opts.enableStaleDetection && opts.staleOptions
    && _stallPolicy && _stallPolicy.shouldAbortStaleStream()
  );

  if (!_staleEnabled) {
    // Legacy path — unchanged behavior.
    for await (const event of eventStream) {
      if (opts.signal?.aborted) break;
      processEvent(event);
    }
    flushOpenToolUses();
    return { content, modelId, tokenUsage, toolUseBlocks, thinking };
  }

  // Gate-on path — manual drive with a stall race.
  const { StreamStaleDetector } = require('./_streamStaleDetector');
  const STALL = Symbol('cw_stall');
  let stallElapsed = 0;
  let resolveStall = null;
  const stallPromise = new Promise((res) => { resolveStall = res; });
  const detector = new StreamStaleDetector({
    ...opts.staleOptions,
    onStale: (elapsed) => {
      stallElapsed = elapsed;
      if (typeof opts.staleOptions.onStale === 'function') {
        try { opts.staleOptions.onStale(elapsed); } catch { /* ignore */ }
      }
      if (resolveStall) resolveStall(STALL);
    },
  });

  const iterator = typeof eventStream[Symbol.asyncIterator] === 'function'
    ? eventStream[Symbol.asyncIterator]()
    : eventStream;

  detector.start();
  try {
    while (true) {
      if (opts.signal?.aborted) break;
      const nextP = Promise.resolve(iterator.next());
      // If a stall wins the race, this promise is abandoned; swallow any late
      // rejection so it never surfaces as an unhandledRejection. Real rejections
      // that arrive before the stall still propagate via the race branch below.
      nextP.catch(() => {});
      const winner = await Promise.race([
        nextP.then((r) => ({ step: r })),
        stallPromise.then((s) => ({ stall: s })),
      ]);

      if (winner.stall === STALL) {
        // Stalled — signal upstream cleanup, then salvage or fail. Do NOT await
        // iterator.return(): a generator suspended at a never-settling await
        // would never resolve return(), re-hanging us. Fire-and-forget instead
        // (swallow any late rejection) — we are already abandoning the stream.
        try {
          if (typeof iterator.return === 'function') {
            const rp = iterator.return();
            if (rp && typeof rp.catch === 'function') rp.catch(() => {});
          }
        } catch { /* ignore */ }
        flushOpenToolUses();
        if (content || toolUseBlocks.length > 0) {
          // Partial progress: hand back what we have so the caller's normal
          // success path keeps the half-answer (continuation-friendly).
          return { content, modelId, tokenUsage, toolUseBlocks, thinking, interrupted: true, finishReason: 'length' };
        }
        // Zero progress: surface a timeout-classified stall error for retry/failover.
        throw _stallPolicy.buildStallError({ provider: opts.staleOptions.provider, elapsedMs: stallElapsed });
      }

      const step = winner.step;
      if (step.done) break;
      detector.touch();
      if (opts.signal?.aborted) break;
      processEvent(step.value);
    }
  } finally {
    detector.stop();
  }

  flushOpenToolUses();
  return { content, modelId, tokenUsage, toolUseBlocks, thinking };
}

module.exports = {
  getCWModule,
  resetCWModuleCache,
  repairToolUsePairing,
  parseCWStreamEvents,
};
