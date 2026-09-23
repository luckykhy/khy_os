'use strict';

/**
 * MCP progressive-disclosure planner (pure function, zero IO except env reads).
 *
 * Problem it solves: every connected MCP server's full tool directory was
 * inlined into the system prompt, so a few chatty servers could crowd out the
 * conversation budget. When the estimated directory size crosses
 * threshold × context window, the whole MCP partition is registered with
 * shouldDefer:true and becomes reachable only through the existing
 * toolSearch/ensureTool reveal path — no parallel invoke-gate is added.
 *
 * Borrowed conclusion from MiniMax-AI/minimax-code mcp-disclosure (proposal
 * 2026-09-18-tier1-minimax-code #2, method reference, MIT upstream).
 */

const DEFAULT_THRESHOLD_PCT = 0.15;
// Fallback window when neither the caller nor env supplies one; deliberately
// conservative (small models exist) and env-overridable — config source per
// RUNTIME-001, not a pinned endpoint-style literal.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000;
const CHARS_PER_TOKEN = 4;

function estimateToolTokens(tools = []) {
  let chars = 0;
  for (const t of tools) {
    if (!t) continue;
    chars += (t.name || '').length + (t.description || '').length;
    if (t.inputJSONSchema) {
      try { chars += JSON.stringify(t.inputJSONSchema).length; } catch { chars += 256; }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function _num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function planMcpDisclosure({ toolCount = 0, estTokens = 0, contextWindowTokens = 0 } = {}, { enabled = true } = {}) {
  const thresholdPct = _num(process.env.KHY_MCP_DISCLOSURE_THRESHOLD_PCT, DEFAULT_THRESHOLD_PCT);
  const window = _num(
    contextWindowTokens || process.env.KHY_MCP_DISCLOSURE_WINDOW,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
  );
  const budgetTokens = Math.floor(window * thresholdPct);
  const overBudget = enabled && toolCount > 0 && estTokens > budgetTokens;
  return {
    mode: overBudget ? 'deferred' : 'inline',
    toolCount,
    estTokens,
    budgetTokens,
    thresholdPct,
    contextWindowTokens: window,
  };
}

function isDisclosureEnabled() {
  return process.env.KHY_MCP_DISCLOSURE !== '0';
}

module.exports = {
  planMcpDisclosure,
  estimateToolTokens,
  isDisclosureEnabled,
  DEFAULT_THRESHOLD_PCT,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
};
