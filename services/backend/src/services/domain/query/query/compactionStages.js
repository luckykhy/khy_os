/**
 * Message-folding stages — the "Stage 1.5 SnipCompact / Stage 2 Microcompact /
 * Stage 2.5 ContextCollapse" concerns of the compact pipeline, extracted
 * behavior-neutral from compactPipeline.js so that leaf stays ≤ the 400-line
 * managed ceiling. Pure-leaf: these three passes are stateless over the message
 * array and reference only their own module-level constants — zero references
 * back to compactPipeline (no cycle). The shared KEEP_RECENT_TURNS window is
 * defined here and re-required by compactPipeline (autocompact still uses it),
 * so the host's public surface stays byte-identical.
 */

const KEEP_RECENT_TURNS = 6; // Preserve this many recent turn pairs (raised from 4 to retain more task context)

const SNIP_THRESHOLD_CHARS = 2000; // assistant 文本超过此长度时截断
const SNIP_KEEP_CHARS = 500; // 截断后保留的前缀字符数

/**
 * 截断非最近轮次中过长的 assistant 文本。
 * 借鉴 Claude Code 的 snipCompact 策略 — 保留头部要点，丢弃冗长推理过程。
 *
 * @param {Array} messages
 * @returns {{ messages: Array, freedChars: number }}
 */
function snipCompact(messages) {
  if (messages.length <= KEEP_RECENT_TURNS * 2) {
    return { messages, freedChars: 0 };
  }

  let freedChars = 0;
  const recentBoundary = messages.length - KEEP_RECENT_TURNS * 2;

  const result = messages.map((msg, i) => {
    if (i >= recentBoundary) {
      return msg;
    }
    if (msg.role !== 'assistant') {
      return msg;
    }
    if (typeof msg.content !== 'string') {
      return msg;
    }
    if (msg.content.length <= SNIP_THRESHOLD_CHARS) {
      return msg;
    }

    const snipped =
      msg.content.slice(0, SNIP_KEEP_CHARS) +
      `\n\n[...snipped ${msg.content.length - SNIP_KEEP_CHARS} chars — old assistant response truncated for context budget]`;
    freedChars += msg.content.length - snipped.length;
    return { ...msg, content: snipped };
  });

  return { messages: result, freedChars };
}

// ── Stage 2: Microcompact ────────────────────────────────────────────

/**
 * Remove duplicate tool results and fold old context into summaries.
 *
 * - Consecutive identical tool results are deduplicated.
 * - Tool results older than KEEP_RECENT_TURNS turns are collapsed to
 *   one-line summaries.
 *
 * @param {Array} messages
 * @returns {{ messages: Array, freedChars: number }}
 */
function microcompact(messages) {
  if (messages.length <= KEEP_RECENT_TURNS * 2) {
    return { messages, freedChars: 0 };
  }

  let freedChars = 0;
  const recentBoundary = messages.length - KEEP_RECENT_TURNS * 2;
  const result = [];
  let prevHash = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Only compress messages before the recent boundary
    if (i < recentBoundary && msg.role === 'user' && typeof msg.content === 'string') {
      // Check for tool result content
      if (msg.content.includes('[Tool execution results]')) {
        // Extract tool names for summary
        const toolNames = [];
        const toolRegex = /Tool:\s*(\w+)/g;
        let match;
        while ((match = toolRegex.exec(msg.content)) !== null) {
          toolNames.push(match[1]);
        }

        const summary =
          toolNames.length > 0
            ? `[Tools executed: ${toolNames.join(', ')} — results omitted for brevity]`
            : '[Tool results omitted for brevity]';

        freedChars += msg.content.length - summary.length;
        result.push({ ...msg, content: summary });
        continue;
      }
    }

    // Deduplicate consecutive identical messages
    const hash = msg.role + ':' + (typeof msg.content === 'string' ? msg.content : '');
    if (hash === prevHash) {
      freedChars += typeof msg.content === 'string' ? msg.content.length : 0;
      continue;
    }
    prevHash = hash;

    result.push(msg);
  }

  return { messages: result, freedChars };
}

// ── Stage 2.5: Context Collapse ─────────────────────────────────────

const COLLAPSE_MIN_CHAIN_LENGTH = 3; // 至少连续 3 轮工具交互链才折叠

/**
 * 折叠连续的工具调用-结果交互链为结构化摘要。
 * 借鉴 Claude Code 的 contextCollapse — 多轮工具循环（如反复编辑+grep+read）
 * 压缩为简洁的交互链摘要，保留最终结果。
 *
 * @param {Array} messages
 * @returns {{ messages: Array, freedChars: number, collapsedChains: number }}
 */
function contextCollapse(messages) {
  if (messages.length <= KEEP_RECENT_TURNS * 2 + COLLAPSE_MIN_CHAIN_LENGTH * 2) {
    return { messages, freedChars: 0, collapsedChains: 0 };
  }

  let freedChars = 0;
  let collapsedChains = 0;
  const recentBoundary = messages.length - KEEP_RECENT_TURNS * 2;
  const result = [];
  let chainStart = -1;
  let chainTools = [];

  function isToolInteraction(msg) {
    if (typeof msg.content !== 'string') {
      return false;
    }
    return (
      msg.content.includes('[Tool execution results]') ||
      msg.content.includes('Tool:') ||
      /^\s*\{.*"tool_use"/.test(msg.content)
    );
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (i >= recentBoundary) {
      // 刷出剩余链
      if (chainStart >= 0 && chainTools.length >= COLLAPSE_MIN_CHAIN_LENGTH) {
        const chainMsgs = messages.slice(chainStart, i);
        const lastMsg = chainMsgs[chainMsgs.length - 1];
        const summary =
          `[Tool interaction chain: ${chainTools.join(' → ')} — ${chainMsgs.length} messages collapsed]\n` +
          `Final result: ${(typeof lastMsg.content === 'string' ? lastMsg.content : '').slice(0, 300)}`;
        const chainChars = chainMsgs.reduce(
          (s, m) => s + (typeof m.content === 'string' ? m.content.length : 0),
          0
        );
        freedChars += chainChars - summary.length;
        collapsedChains++;
        result.push({ role: 'user', content: summary });
      } else if (chainStart >= 0) {
        result.push(...messages.slice(chainStart, i));
      }
      chainStart = -1;
      chainTools = [];
      result.push(msg);
      continue;
    }

    if (isToolInteraction(msg)) {
      if (chainStart < 0) {
        chainStart = i;
      }
      // 提取工具名
      const toolMatch = msg.content.match(/Tool:\s*(\w+)/);
      if (toolMatch && !chainTools.includes(toolMatch[1])) {
        chainTools.push(toolMatch[1]);
      }
    } else {
      // 链结束
      if (chainStart >= 0 && chainTools.length >= COLLAPSE_MIN_CHAIN_LENGTH) {
        const chainMsgs = messages.slice(chainStart, i);
        const lastMsg = chainMsgs[chainMsgs.length - 1];
        const summary =
          `[Tool interaction chain: ${chainTools.join(' → ')} — ${chainMsgs.length} messages collapsed]\n` +
          `Final result: ${(typeof lastMsg.content === 'string' ? lastMsg.content : '').slice(0, 300)}`;
        const chainChars = chainMsgs.reduce(
          (s, m) => s + (typeof m.content === 'string' ? m.content.length : 0),
          0
        );
        freedChars += chainChars - summary.length;
        collapsedChains++;
        result.push({ role: 'user', content: summary });
      } else if (chainStart >= 0) {
        result.push(...messages.slice(chainStart, i));
      }
      chainStart = -1;
      chainTools = [];
      result.push(msg);
    }
  }

  return { messages: result, freedChars, collapsedChains };
}

module.exports = {
  KEEP_RECENT_TURNS,
  SNIP_THRESHOLD_CHARS,
  SNIP_KEEP_CHARS,
  COLLAPSE_MIN_CHAIN_LENGTH,
  snipCompact,
  microcompact,
  contextCollapse,
};
