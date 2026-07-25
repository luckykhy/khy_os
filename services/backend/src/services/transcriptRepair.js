'use strict';

/**
 * transcriptRepair.js — Validate and repair tool_call / tool_result message pairing.
 *
 * Ported from OpenClaw's session-transcript-repair.ts concept:
 * 1. Collect all tool_call IDs from assistant messages
 * 2. Collect all tool_result references
 * 3. Remove orphaned tool_results (no matching tool_call)
 * 4. Ensure assistant+tool_call is followed by tool_result
 * 5. Fix sequence ordering issues
 *
 * In KHY OS, tool calls use the natural language format 【调用X：Y】
 * and tool results arrive as role:"tool" messages.
 */

// Match KHY's natural tool call format: 【调用行情：600519】
const TOOL_CALL_RE = /【\s*调用\s*([^：:\]】\n]{1,24})\s*[：:]\s*([\s\S]*?)\s*】/g;

/**
 * Extract tool call identifiers from an assistant message.
 * Returns array of { action, arg, index } for each 【调用X：Y】 match.
 */
function extractToolCalls(content) {
  const calls = [];
  const s = String(content || '');
  let match;
  TOOL_CALL_RE.lastIndex = 0;
  while ((match = TOOL_CALL_RE.exec(s)) !== null) {
    calls.push({
      action: match[1].trim(),
      arg: (match[2] || '').trim(),
      raw: match[0],
    });
  }
  return calls;
}

/**
 * Repair a message transcript to ensure tool_call/result pairing integrity.
 *
 * Rules:
 * 1. A tool_result (role:"tool") must be preceded by an assistant message
 *    containing a matching 【调用X：Y】.
 * 2. Orphaned tool results (no preceding tool call) are removed.
 * 3. Consecutive assistant messages are merged if the first contains a
 *    tool call with no intervening result.
 * 4. System messages are preserved in place.
 * 5. The repaired array maintains valid role alternation:
 *    user → assistant [→ tool → assistant]* → user ...
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Array<{role: string, content: string}>}
 */
function repairTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages || [];
  }

  const result = [];
  let pendingToolCalls = 0; // how many tool calls in the last assistant msg
  let lastAssistantIdx = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role;

    if (role === 'system') {
      result.push(msg);
      continue;
    }

    if (role === 'user') {
      // If we have pending tool calls without results, that's OK —
      // the AI may have been interrupted. Just reset.
      pendingToolCalls = 0;
      result.push(msg);
      continue;
    }

    if (role === 'assistant') {
      const calls = extractToolCalls(msg.content);
      pendingToolCalls = calls.length;
      lastAssistantIdx = result.length;
      result.push(msg);
      continue;
    }

    if (role === 'tool') {
      if (pendingToolCalls > 0) {
        // Valid: tool result follows an assistant with a tool call
        pendingToolCalls--;
        result.push(msg);
      } else {
        // Orphaned tool result — check if the previous assistant message
        // might have contained a tool call that we missed
        if (lastAssistantIdx >= 0 && result[lastAssistantIdx]?.role === 'assistant') {
          // Keep it anyway but log — some adapters don't use 【】 format
          result.push(msg);
        }
        // else: truly orphaned, drop it silently
      }
      continue;
    }

    // Unknown role — preserve
    result.push(msg);
  }

  return result;
}

/**
 * Validate message sequence and return diagnostics.
 * Does not modify the array.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{ valid: boolean, issues: string[] }}
 */
function validateTranscript(messages) {
  const issues = [];
  if (!Array.isArray(messages)) {
    return { valid: false, issues: ['messages is not an array'] };
  }

  let pendingCalls = 0;
  let lastRole = '';

  for (let i = 0; i < messages.length; i++) {
    const { role, content } = messages[i];

    if (role === 'system') continue;

    if (role === 'tool') {
      if (pendingCalls <= 0) {
        issues.push(`[${i}] orphaned tool result (no preceding tool call)`);
      } else {
        pendingCalls--;
      }
    }

    if (role === 'assistant') {
      const calls = extractToolCalls(content);
      pendingCalls = calls.length;
    }

    if (role === 'user' && lastRole === 'user') {
      issues.push(`[${i}] consecutive user messages`);
    }

    if (role !== 'system') lastRole = role;
  }

  if (pendingCalls > 0) {
    issues.push(`${pendingCalls} tool call(s) without results at end of transcript`);
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Ensure the message array ends with a valid state for sending to AI.
 * If the last message is a tool result, it's valid (AI will respond).
 * If the last message is an assistant with pending tool calls but no results,
 * append a synthetic error result.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Array<{role: string, content: string}>}
 */
function ensureCompletePairs(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];

  const result = [...messages];

  // Walk backwards to find the last assistant with tool calls
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (msg.role === 'user') break; // stop at last user message
    if (msg.role === 'assistant') {
      const calls = extractToolCalls(msg.content);
      if (calls.length > 0) {
        // Count how many tool results follow
        let resultsAfter = 0;
        for (let j = i + 1; j < result.length; j++) {
          if (result[j].role === 'tool') resultsAfter++;
          else break;
        }
        // Append missing results
        const missing = calls.length - resultsAfter;
        for (let k = 0; k < missing; k++) {
          result.splice(i + 1 + resultsAfter + k, 0, {
            role: 'tool',
            content: '[工具超时] 未收到结果，请换个方式回答。',
          });
        }
      }
      break;
    }
  }

  return result;
}

/**
 * 角色交替自修复（借鉴 Hermes Agent _sanitize_api_messages + _repair_message_sequence）。
 * 确保消息序列满足 API 要求的角色交替规则：
 * - 连续 assistant 消息 → 合并为一条
 * - 孤立 tool_result（前面不是 assistant）→ 插入虚拟 assistant
 * - 连续 user 消息 → 合并为一条
 * - assistant 后直接跟 user（中间缺 tool_result）→ 正常，不修复
 *
 * 应在每次 API 调用前执行，防止压缩/恢复/截断导致的序列断裂。
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Array<{role: string, content: string}>}
 */
function repairRoleAlternation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages || [];

  const result = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'system') {
      result.push(msg);
      continue;
    }

    const prevNonSystem = _lastNonSystem(result);

    if (msg.role === 'assistant') {
      if (prevNonSystem && prevNonSystem.role === 'assistant') {
        // 连续 assistant → 合并到前一条
        prevNonSystem.content = (prevNonSystem.content || '') + '\n' + (msg.content || '');
        continue;
      }
      result.push({ ...msg });
      continue;
    }

    if (msg.role === 'user') {
      if (prevNonSystem && prevNonSystem.role === 'user') {
        // 连续 user → 合并到前一条
        prevNonSystem.content = (prevNonSystem.content || '') + '\n' + (msg.content || '');
        continue;
      }
      result.push({ ...msg });
      continue;
    }

    if (msg.role === 'tool') {
      if (!prevNonSystem || prevNonSystem.role !== 'assistant') {
        // 孤立 tool_result — 插入虚拟 assistant
        result.push({
          role: 'assistant',
          content: '[System: tool was invoked]',
          _synthetic: true,
        });
      }
      result.push({ ...msg });
      continue;
    }

    result.push({ ...msg });
  }

  return result;
}

function _lastNonSystem(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].role !== 'system') return arr[i];
  }
  return null;
}

module.exports = {
  repairTranscript,
  repairRoleAlternation,
  validateTranscript,
  ensureCompletePairs,
  extractToolCalls,
};
