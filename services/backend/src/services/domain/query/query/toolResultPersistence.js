/**
 * Tool-result persistence — the "Stage 1: Tool Result Budget" concern of the
 * compact pipeline, extracted behavior-neutral from compactPipeline.js so that
 * leaf stays ≤ the 400-line managed ceiling. Pure-leaf: only built-in IO
 * (fs/os/path) and its own module-level constants — zero references back to
 * compactPipeline (no cycle). compactPipeline re-requires and re-binds these
 * names so its public surface stays byte-identical.
 */

const DEFAULT_MAX_RESULT_CHARS = 5000;

// ── Tool result persistence ────────────────────────────────────────
// Large tool results are saved to disk with a short preview in-message.
// This prevents context window blowup from verbose tool outputs.
const PERSIST_THRESHOLD_CHARS = 50_000; // Results > 50K chars → disk
const PERSIST_PREVIEW_CHARS = 2_000; // Keep 2K preview inline

// ── Per-message aggregation budget ─────────────────────────────────
// Total chars of tool results allowed per single message before persistence.
const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Persist a large tool result to disk, returning a preview + file path.
 * @param {string} content - Full tool result content
 * @param {string} toolName - Tool that produced this result
 * @returns {{ preview: string, filePath: string }}
 */
function _persistToolResult(content, toolName) {
  const dir = path.join(os.tmpdir(), 'khy-tool-results');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }

  const id = `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const filePath = path.join(dir, `${id}.txt`);
  try {
    fs.writeFileSync(filePath, content, 'utf8');
  } catch {
    return null;
  }

  const preview = content.slice(0, PERSIST_PREVIEW_CHARS);
  return { preview, filePath };
}

/**
 * Truncate tool result messages that exceed the character budget.
 * Large results (>50K chars) are persisted to disk with a preview.
 * Per-message aggregation budget (200K chars) prevents context blowup.
 *
 * @param {Array} messages - Conversation messages
 * @param {number} [maxChars=5000] - Max chars per tool result
 * @returns {{ messages: Array, freedChars: number, persistedCount: number }}
 */
function applyToolResultBudget(messages, maxChars = DEFAULT_MAX_RESULT_CHARS) {
  let freedChars = 0;
  let persistedCount = 0;
  let perMessageAccum = 0;

  const result = messages.map((msg) => {
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      return msg;
    }

    const content = msg.content;
    if (typeof content !== 'string') {
      return msg;
    }

    // Detect tool result patterns
    if (!content.includes('[Tool execution results]') && !content.startsWith('Result:')) {
      return msg;
    }

    perMessageAccum += content.length;

    // Per-message aggregation budget: if total tool results in one message
    // exceed 200K chars, persist the excess to disk
    if (
      perMessageAccum > MAX_TOOL_RESULTS_PER_MESSAGE_CHARS &&
      content.length > PERSIST_THRESHOLD_CHARS
    ) {
      const persisted = _persistToolResult(content, 'aggregate');
      if (persisted) {
        persistedCount++;
        const replacement = `${persisted.preview}\n\n<persisted-output path="${persisted.filePath}" original-length="${content.length}" />\n(Full output saved to disk. Use ReadFile to access if needed.)`;
        freedChars += content.length - replacement.length;
        return { ...msg, content: replacement };
      }
    }

    // Large result persistence (>50K chars)
    if (content.length > PERSIST_THRESHOLD_CHARS) {
      const persisted = _persistToolResult(content, 'tool');
      if (persisted) {
        persistedCount++;
        const replacement = `${persisted.preview}\n\n<persisted-output path="${persisted.filePath}" original-length="${content.length}" />\n(Full output saved to disk. Use ReadFile to access if needed.)`;
        freedChars += content.length - replacement.length;
        return { ...msg, content: replacement };
      }
    }

    // Standard truncation
    if (content.length <= maxChars) {
      return msg;
    }

    const truncated = content.slice(0, maxChars) + `\n... (truncated from ${content.length} chars)`;
    freedChars += content.length - truncated.length;
    return { ...msg, content: truncated };
  });

  return { messages: result, freedChars, persistedCount };
}

/**
 * s08 L3 "budget" preservation pass — the one piece the live `cli/ai.js`
 * compaction path was missing.
 *
 * KHY's live context path (contextRouter.truncateToolResults + sliding window)
 * TRUNCATES or drops oversized tool results, so anything past the cap is lost
 * for good. Claude Code instead PERSISTS the full output to disk and leaves a
 * `<persisted-output path=… />` marker plus a preview, so the model can fetch
 * the complete result later with ReadFile. This function supplies exactly that
 * preservation step, to run BEFORE truncation/sliding-window so those stages
 * only ever shrink the short marker, never discard real data.
 *
 * It is deliberately narrow: it ONLY persists results larger than
 * PERSIST_THRESHOLD_CHARS and replaces them in-place with a marker. It performs
 * no truncation of its own (that stays the routing layer's job) and is
 * idempotent — a marker already contains `<persisted-output ` so a re-run skips
 * it. Both KHY tool-result encodings are handled:
 *   A) string content carrying an "[Tool execution results]" / "Result:" block
 *   B) structured tool_result blocks (role:'user', content: array of blocks)
 *
 * @param {Array} messages - conversation messages (mutated in place)
 * @returns {{ messages: Array, persistedCount: number, freedChars: number }}
 */
function persistOversizedToolResults(messages) {
  if (!Array.isArray(messages)) {
    return { messages, persistedCount: 0, freedChars: 0 };
  }

  let persistedCount = 0;
  let freedChars = 0;

  const buildMarker = (persisted, originalLength) =>
    `${persisted.preview}\n\n<persisted-output path="${persisted.filePath}" original-length="${originalLength}" />\n(Full output saved to disk. Use ReadFile to access if needed.)`;

  for (const msg of messages) {
    if (!msg) {
      continue;
    }
    const content = msg.content;

    // Form A: string content carrying a tool-execution-results block.
    if (typeof content === 'string') {
      const looksLikeToolResult =
        content.includes('[Tool execution results]') || content.startsWith('Result:');
      if (
        looksLikeToolResult &&
        content.length > PERSIST_THRESHOLD_CHARS &&
        !content.includes('<persisted-output ')
      ) {
        const persisted = _persistToolResult(content, 'tool');
        if (persisted) {
          const marker = buildMarker(persisted, content.length);
          freedChars += content.length - marker.length;
          msg.content = marker;
          persistedCount++;
        }
      }
      continue;
    }

    // Form B: structured tool_result blocks (role:'user', content: array).
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          block.type === 'tool_result' &&
          typeof block.content === 'string' &&
          block.content.length > PERSIST_THRESHOLD_CHARS &&
          !block.content.includes('<persisted-output ')
        ) {
          const persisted = _persistToolResult(block.content, 'tool');
          if (persisted) {
            const marker = buildMarker(persisted, block.content.length);
            freedChars += block.content.length - marker.length;
            block.content = marker;
            persistedCount++;
          }
        }
      }
    }
  }

  return { messages, persistedCount, freedChars };
}

module.exports = {
  _persistToolResult,
  applyToolResultBudget,
  persistOversizedToolResults,
  PERSIST_THRESHOLD_CHARS,
  PERSIST_PREVIEW_CHARS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
};
