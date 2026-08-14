'use strict';

/**
 * contextRouter.js — Preemptive context overflow routing.
 *
 * Evaluates total token usage BEFORE sending to AI and selects
 * the optimal strategy to stay within budget.
 *
 * Ported from OpenClaw's preemptive-compaction.ts:
 * 4 routes: fits | compact_only | truncate_tool_results_only | compact_then_truncate
 *
 * Constants (from OpenClaw):
 *   SAFETY_MARGIN = 1.2
 *   SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5
 *   PREEMPTIVE_OVERFLOW_RATIO = 0.9
 *   TRUNCATION_ROUTE_BUFFER_TOKENS = 512
 */

const { estimateTokens } = require('./contextWasm');
let _contentToText;
try {
  _contentToText = require('./contentBlockUtils').contentToText;
} catch {
  _contentToText = (c) => String(c || '');
}

// Y-code inspired: lossless whitespace compression for tool results (saves 10-20% tokens)
let _sourceTextCompress;
try {
  _sourceTextCompress = require('../utils/sourceTextCompressor');
} catch {
  _sourceTextCompress = null;
}
function _compressText(text) {
  if (!_sourceTextCompress || !text || text.length < 100) {
    return text;
  }
  try {
    return _sourceTextCompress.compress(text).compressed;
  } catch {
    return text;
  }
}

const SAFETY_MARGIN = 1.2;
// 自动压缩触发比例(阈值 = contextBudget × PREEMPTIVE_RATIO)。可经
// KHY_CONTEXT_PREEMPTIVE_RATIO 覆盖(0,1] 内的数值,默认 0.9 → 逐字节回退历史行为。
// 调低(如 0.1)可让压缩在更早的上下文占用时触发,便于演示压缩动画;底栏倒计时
// (autoCompactTriggerTokens = budget × ratio / SAFETY_MARGIN)与其代数一致,不会漂移。
// 非法/越界值 → 0.9。
const PREEMPTIVE_RATIO = (() => {
  const raw = Number(process.env.KHY_CONTEXT_PREEMPTIVE_RATIO);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.9;
})();
const SINGLE_RESULT_SHARE = 0.5;
const TRUNCATION_BUFFER = 512;
// A3: 硬地板 — 低 token 时不触发压缩，保护 prefix cache（学习自 DeepSeek-TUI 500K 硬地板）
// 动态化：与模型 context window 成比例，小模型不会因 floor > budget 永不压缩。
// KHY_CONTEXT_HARD_FLOOR=0 可关闭硬地板(压缩演示用)。原 `Number(...) || 32768` 使 0
// 被 || 吞成 32768、永远关不掉;改为 Number.isFinite 判定,0 合法,未设回退 32768。
const HARD_FLOOR_TOKENS_DEFAULT = (() => {
  const raw = Number(process.env.KHY_CONTEXT_HARD_FLOOR);
  return Number.isFinite(raw) && raw >= 0 ? raw : 32768;
})();
function getHardFloor(contextBudget) {
  if (!Number.isFinite(contextBudget) || contextBudget <= 0) {
    return HARD_FLOOR_TOKENS_DEFAULT;
  }
  return Math.min(HARD_FLOOR_TOKENS_DEFAULT, Math.floor(contextBudget * 0.15));
}

/**
 * Sum token count of all tool result messages.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {number}
 */
function sumToolResultTokens(messages) {
  let total = 0;
  for (const m of messages) {
    if (m.role === 'tool') {
      total += estimateTokens(_contentToText(m.content));
    }
  }
  return total;
}

/**
 * Determine the routing strategy for context management.
 *
 * @param {Array<{role: string, content: string}>} messages - Conversation messages
 * @param {string} systemPrompt - Full system prompt
 * @param {string} userPrompt - Current user input
 * @param {number} contextBudget - Max tokens allowed
 * @returns {{ route: string, overflow: number, toolResultTokens: number }}
 */
function routeContextStrategy(messages, systemPrompt, userPrompt, contextBudget) {
  const msgTokens = messages.reduce((sum, m) => sum + estimateTokens(_contentToText(m.content)), 0);
  const sysTokens = estimateTokens(systemPrompt);
  const userTokens = estimateTokens(userPrompt);
  const totalTokens = Math.ceil((msgTokens + sysTokens + userTokens) * SAFETY_MARGIN);

  // A3: 硬地板 — 低 token 时直接返回 fits，不触发任何压缩
  if (totalTokens < getHardFloor(contextBudget)) {
    return { route: 'fits', overflow: 0, toolResultTokens: 0 };
  }

  const threshold = Math.floor(contextBudget * PREEMPTIVE_RATIO);
  const overflow = totalTokens - threshold;

  if (overflow <= 0) {
    return { route: 'fits', overflow: 0, toolResultTokens: 0 };
  }

  const toolResultTokens = sumToolResultTokens(messages);

  // No tool results to truncate — can only compact
  if (toolResultTokens === 0) {
    return { route: 'compact_only', overflow, toolResultTokens: 0 };
  }

  // How much can we save by truncating tool results (cap each at 50%)?
  const reducible = Math.floor(toolResultTokens * SINGLE_RESULT_SHARE);

  if (reducible >= overflow + TRUNCATION_BUFFER) {
    return { route: 'truncate_tool_results_only', overflow, toolResultTokens };
  }

  return { route: 'compact_then_truncate', overflow, toolResultTokens };
}

/**
 * Pre-compress tool results: strip trailing whitespace + merge consecutive blank
 * lines (lossless whitespace compression, saves 10-20% tokens). Runs BEFORE
 * truncation so the head/tail cuts operate on already-compressed text.
 *
 * Modifies messages in-place. Returns total chars saved.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {number} Total bytes saved
 */
function preCompressToolResults(messages) {
  if (!_sourceTextCompress) {
    return 0;
  }
  let saved = 0;
  for (const msg of messages) {
    if (msg.role !== 'tool') {
      continue;
    }
    const text = _contentToText(msg.content);
    if (!text || text.length < 100) {
      continue;
    }
    const compressed = _compressText(text);
    if (compressed !== text) {
      const beforeBytes = Buffer.byteLength(text, 'utf8');
      msg.content = compressed;
      saved += beforeBytes - Buffer.byteLength(compressed, 'utf8');
    }
  }
  return saved;
}

/**
 * Truncate oversized tool results in-place.
 * Caps each tool result at `maxTokensPerResult` tokens.
 *
 * Loss-reducing truncation (可交付性): before the legacy hard character cut,
 * try smartTruncation's per-tool noise classification (keep errors / summary /
 * head+tail, drop build logs / passing tests / repetitive matches). This keeps
 * far more signal than a blind middle cut. smartTruncation failure → legacy
 * hard cut (byte-identical fallback).
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} targetReduction - How many tokens to save
 */
function truncateToolResults(messages, targetReduction) {
  let saved = 0;

  for (let i = 0; i < messages.length && saved < targetReduction; i++) {
    // 结构化 tool_result（role='user', content 含 tool_result blocks）
    if (
      messages[i].role === 'user' &&
      Array.isArray(messages[i].content) &&
      messages[i].content.some((b) => b && b.type === 'tool_result')
    ) {
      for (const block of messages[i].content) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          const before = block.content;
          const tokens = estimateTokens(before);
          const maxTokens = Math.floor(tokens * SINGLE_RESULT_SHARE);
          if (tokens > maxTokens) {
            const shrunk = _smartTruncateOrHard(before);
            if (shrunk && shrunk.length < before.length) {
              block.content = shrunk;
              saved += tokens - estimateTokens(block.content);
            }
          }
        }
      }
      continue;
    }

    if (messages[i].role !== 'tool') {
      continue;
    }

    const content = _contentToText(messages[i].content);
    const tokens = estimateTokens(content);
    const maxTokens = Math.floor(tokens * SINGLE_RESULT_SHARE);

    if (tokens > maxTokens) {
      const shrunk = _smartTruncateOrHard(content);
      if (shrunk && shrunk.length < content.length) {
        messages[i] = { role: 'tool', content: shrunk };
        saved += tokens - estimateTokens(messages[i].content);
      }
    }
  }

  return saved;
}

/**
 * Loss-reducing tool-result shrink: prefer smartTruncation (per-tool noise
 * classification keeps signal, drops noise). When the smart path is
 * unavailable or produces no reduction, fall back to a **head+tail** cut
 * (keep the first section AND the trailing lines — errors/summaries live at
 * the end) instead of the legacy blind middle cut that dropped the tail.
 * The tool name is inferred from the `[Tool:Name]` prefix when present so the
 * noise profile (shell / grep / test / build …) applies.
 *
 * @param {string} content - tool result text (possibly with `[Tool:Name]` prefix)
 * @returns {string} reduced text (identical content when nothing could be saved)
 */
function _smartTruncateOrHard(content) {
  const raw = String(content || '');
  if (!raw) {
    return raw;
  }

  // 幂等:内容已含省略标记(truncated ... chars / context-compressed)→ 已降损过一次,
  // 不再重复截断。重复截断会挤掉尾部错误信息,且让标记层层嵌套(可交付性受损)。
  if (/chars (omitted|truncated)|context-compressed/i.test(raw)) {
    return raw;
  }

  // Infer tool name from the standard `[Tool:Name]` prefix.
  let toolName = '';
  let body = raw;
  const mt = raw.match(/^\[Tool:([^\]]+)\]\s*([\s\S]*)$/);
  if (mt) {
    toolName = mt[1].trim();
    body = mt[2];
  }

  // Target: halve the tokens (SINGLE_RESULT_SHARE), same budget as legacy.
  const tokens = estimateTokens(raw);
  const maxTokens = Math.floor(tokens * SINGLE_RESULT_SHARE);
  // Convert the token budget to a char budget using the ACTUAL char/token ratio
  // of this content (a hardcoded ~4 chars/token silently disables the fallback
  // when the tokenizer counts differently — e.g. a 1:1 estimator in tests, or
  // CJK-heavy text where each char is a token).
  const estRatio = Math.max(1, raw.length / Math.max(1, tokens));
  const maxChars = Math.max(200, Math.floor(maxTokens * estRatio));

  try {
    const smart = require('./smartTruncation');
    if (typeof smart.truncate === 'function' && body.length > 500) {
      const res = smart.truncate(toolName, body, {});
      if (res && typeof res.text === 'string' && res.text.length < body.length) {
        const suffix = `\n[context-compressed: ${res.strategy || 'noise-filtered'}; was ${body.length} chars]`;
        const out = toolName ? `[Tool:${toolName}] ${res.text}${suffix}` : `${res.text}${suffix}`;
        // Only take the smart result if it actually reduced the size.
        if (out.length < raw.length) {
          return out;
        }
      }
    }
  } catch {
    /* smartTruncation unavailable — fall through to head+tail cut */
  }

  // Head + tail fallback (loss-reducing): keep the leading content and the
  // trailing lines, omit the repetitive middle. Better than the legacy blind
  // head cut because tool errors/summaries usually sit at the end of the text.
  if (raw.length > maxChars) {
    const headLen = Math.floor(maxChars * 0.7);
    const tailBudget = Math.max(60, maxChars - headLen - 60);
    const head = raw.slice(0, headLen);
    let tail = '';
    let tailChars = 0;
    let idx = raw.length;
    while (idx > 0 && tailChars < tailBudget) {
      const nl = raw.lastIndexOf('\n', idx - 1);
      const line = raw.slice(nl + 1, idx);
      if (line.length === 0) {
        idx = nl;
        continue;
      }
      if (tailChars + line.length > tailBudget) {
        break;
      }
      tail = line + tail;
      tailChars += line.length;
      idx = nl;
    }
    const omitted = raw.length - head.length - tail.length;
    if (omitted > 0) {
      return `${head}\n... [truncated ${omitted} chars — showing first and trailing output]\n${tail}`;
    }
  }

  // Nothing could be saved (or the content already fits) — return as-is.
  return raw;
}

/**
 * 自动压缩真实触发点(绝对 token 数) —— routeContextStrategy 触发条件的代数逆。
 *
 * routeContextStrategy 里判定「不 fits」的条件是
 *   ceil(raw * SAFETY_MARGIN) > floor(contextBudget * PREEMPTIVE_RATIO)
 * 即 raw > contextBudget * PREEMPTIVE_RATIO / SAFETY_MARGIN = contextBudget * 0.75。
 * 把这个数**推导**出来而不是在 UI 侧另写一个比例常量,是为了让「底栏倒计时」与
 * 「真实压缩行为」在结构上不可能漂移 —— 历史上 UI 用 0.8×window、真实触发是
 * 0.75×budget,而 budget 已经扣过 reserve 与 ~12% safety,两者叠加后 UI 承诺 80%
 * 而实际在窗口的约 63% 就压缩了(512k 下差 17 个百分点)。
 *
 * 注意返回值以 **contextBudget** 为基准,不是 contextWindow —— 窗口→预算的折算随
 * taskScale/preset.maxTokens/三个 env 浮动,任何「占窗口固定比例」的表达都必然说谎。
 *
 * @param {number} contextBudget 由 _resolveContextBudget 算出的可用预算
 * @returns {number} 触发压缩的已用 token 阈值;入参非法 → 0(调用方据此降级)
 */
function autoCompactTriggerTokens(contextBudget) {
  const b = Number(contextBudget);
  if (!Number.isFinite(b) || b <= 0) {
    return 0;
  }
  return Math.floor((b * PREEMPTIVE_RATIO) / SAFETY_MARGIN);
}

module.exports = {
  routeContextStrategy,
  truncateToolResults,
  preCompressToolResults,
  sumToolResultTokens,
  SAFETY_MARGIN,
  PREEMPTIVE_RATIO,
  SINGLE_RESULT_SHARE,
  HARD_FLOOR_TOKENS: HARD_FLOOR_TOKENS_DEFAULT,
  getHardFloor,
  autoCompactTriggerTokens,
};
