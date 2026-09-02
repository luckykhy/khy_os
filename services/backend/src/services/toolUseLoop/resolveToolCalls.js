'use strict';

/**
 * Tool-call resolution decision chain extracted from runToolUseLoop
 * (T-021 C3-P7 first slice — the pattern-proof for C3 decision clusters).
 *
 * Owns, verbatim from the former loop body:
 *   - signal semantics (s20): structured toolUseBlocks are authoritative;
 *     stop_reason is only a secondary hint for the degraded text-parse path.
 *   - text protocol as FIRST-CLASS (weak-local models) — adapter-driven parse,
 *     no warning.
 *   - structured native blocks (server_tool_use filtered) → canonicalized calls.
 *   - stop_reason=tool_use without blocks → text-parse recovery attempt
 *     (tool-parse-fallback / tool-parse-recovered breadcrumbs).
 *   - plain text parse for non-native models (calm) vs adapter gap (warning).
 *   - parse-failure diagnostic: tool-parse-empty-despite-signal (observability
 *     only, no behavior change).
 *
 * Pure decision cluster: reads its inputs, never mutates loop state. Every
 * formerly closure-bound identifier arrives via the deps bag; breadcrumbs are
 * injected so the observability trail stays byte-identical.
 */

const { normalizeToolCall } = require('../claudeCompat');

function resolveToolCalls(deps) {
  const {
    aiResult,
    normalizedStopReason,
    isTextProtocol,
    activeAdapter,
    modelLacksNativeTools,
    iteration,
    parseToolCalls,
    canonicalizeToolCall,
    loopBreadcrumb,
  } = deps;

  // s20: the primary continuation signal is the PRESENCE of structured
  // toolUseBlocks, NOT stop_reason. Claude Code does not trust
  // stop_reason === 'tool_use'; the actual tool_use blocks in the response
  // are authoritative (see `hasStructuredToolUse` gate below). stop_reason
  // is only consulted as a secondary hint for the degraded text-parse path.
  // Text-based <tool_call> parsing is a fallback for non-native adapters.
  let toolCalls;
  const hasStructuredToolUse =
    Array.isArray(aiResult.toolUseBlocks) && aiResult.toolUseBlocks.length > 0;
  const stopReasonIsToolUse = normalizedStopReason === 'tool_use';

  if (isTextProtocol) {
    // Text protocol is FIRST-CLASS here (weak-local models): parse <tool_call>
    // JSON from raw model text via the adapter. Not a degraded fallback — no
    // warning. Still canonicalized so downstream execution matches the native
    // path exactly.
    toolCalls = activeAdapter.parseToolCalls(aiResult).map(canonicalizeToolCall);
  } else if (hasStructuredToolUse) {
    // Native structured tool_use from Claude/OpenAI API — authoritative path
    // Filter out server_tool_use blocks — these are handled server-side (e.g. tool_search)
    // and must not be dispatched to local tool execution.
    toolCalls = aiResult.toolUseBlocks
      .filter((block) => block.type !== 'server_tool_use')
      .map((block) => {
        const name = block.name || block.function?.name || '';
        let params = block.input || block.params || block.function?.arguments || {};
        if (typeof params === 'string') {
          try {
            params = JSON.parse(params);
          } catch {
            params = {};
          }
        }
        const normalized = normalizeToolCall(name, params);
        return {
          name: normalized.name,
          params: normalized.params,
          _toolUseId: block.id || block.tool_use_id || null,
          _structured: true,
        };
      })
      .map(canonicalizeToolCall);
  } else if (stopReasonIsToolUse) {
    // stop_reason says tool_use but no structured blocks — adapter 可能未正确传递。
    // 不静默放弃，回退到文本解析尝试恢复工具调用。
    loopBreadcrumb('tool-parse-fallback', {
      stopReason: aiResult.stopReason,
      reason: 'no toolUseBlocks',
    });
    toolCalls = parseToolCalls(aiResult.reply).map(canonicalizeToolCall);
    if (toolCalls.length > 0) {
      loopBreadcrumb('tool-parse-recovered', {
        count: toolCalls.length,
        method: 'text-fallback',
      });
    }
  } else {
    // Text-based <tool_call> parsing. For models known to lack native tool
    // calling this is the EXPECTED text-interception path (calm breadcrumb);
    // for a model that SHOULD return structured blocks it signals an adapter
    // gap (warning). Either way the call is parsed + executed identically.
    toolCalls = parseToolCalls(aiResult.reply).map(canonicalizeToolCall);
    if (toolCalls.length > 0) {
      if (modelLacksNativeTools) {
        loopBreadcrumb('tool-parse-text-protocol', {
          count: toolCalls.length,
          expected: true,
        });
      } else {
        loopBreadcrumb('tool-parse-text-fallback', {
          count: toolCalls.length,
          reason: 'adapter-gap',
        });
      }
    }
  }

  // Parse-failure diagnostic (P2, observability only — no behavior change):
  // the response carried a structured tool_use signal or a tool_use
  // stop_reason, yet parsing yielded zero tool calls. Surface it so silent
  // "model wanted a tool but nothing ran" turns are attributable.
  if (toolCalls.length === 0 && (hasStructuredToolUse || stopReasonIsToolUse)) {
    loopBreadcrumb('tool-parse-empty-despite-signal', {
      iteration,
      stopReason: aiResult.stopReason,
      hasStructuredToolUse,
      replyHead: String(aiResult.reply || '').slice(0, 200),
    });
  }

  return toolCalls;
}

module.exports = { resolveToolCalls };
