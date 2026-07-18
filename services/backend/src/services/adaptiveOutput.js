'use strict';

/**
 * Adaptive Output Escalation — detect response truncation and retry with higher limits.
 *
 * When the AI response is truncated (hits output token limit), this service:
 *   1. Detects truncation via finish_reason or output length
 *   2. Escalates the output token limit (e.g., 8K → 64K)
 *   3. Retries the request with the higher limit
 *
 * Also provides long-running command advisory for promoting to background.
 *
 * Inspired by Qwen Code's adaptive-output-token-escalation design.
 *
 * @module adaptiveOutput
 */

// ── Constants ──────────────────────────────────────────────────────

const INITIAL_OUTPUT_CAP = 8192;          // 8K tokens — saves GPU slot reservation
const ESCALATED_OUTPUT_CAP = 65536;       // 64K tokens — full capacity
const TRUNCATION_SIGNAL_CHARS = 200;      // Min chars to consider a valid partial response

// ── Global Timeout Multiplier ──────────────────────────────────────

/**
 * Get the global timeout multiplier.
 * Users can set KHY_TIMEOUT_MULTIPLIER=2.0 to double all timeouts.
 * @returns {number}
 */
function getTimeoutMultiplier() {
  const raw = process.env.KHY_TIMEOUT_MULTIPLIER;
  if (!raw) return 1.0;
  const val = parseFloat(raw);
  if (!Number.isFinite(val) || val <= 0) return 1.0;
  return Math.max(0.1, Math.min(10.0, val));
}

/**
 * Apply the global timeout multiplier to a timeout value.
 * @param {number} baseMs - Base timeout in milliseconds
 * @returns {number}
 */
function applyMultiplier(baseMs) {
  return Math.round(baseMs * getTimeoutMultiplier());
}

// ── Truncation Detection ───────────────────────────────────────────

/**
 * Detect if an AI response was truncated.
 *
 * @param {object} response - AI response object
 * @param {string} [response.reply] - Response text
 * @param {string} [response.finish_reason] - 'stop', 'length', 'max_tokens', etc.
 * @param {object} [response.tokenUsage] - { output_tokens, output_token_limit }
 * @param {number} [currentCap] - Current output token cap
 * @returns {{ truncated: boolean, reason?: string }}
 */
function detectTruncation(response, currentCap) {
  if (!response) return { truncated: false };

  // Explicit truncation signal from API
  const finishReason = response.finish_reason || response.stop_reason || '';
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    return { truncated: true, reason: `finish_reason=${finishReason}` };
  }

  // Token usage check: output_tokens >= 95% of limit
  const usage = response.tokenUsage || response.usage || {};
  const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
  const limit = usage.output_token_limit || currentCap || INITIAL_OUTPUT_CAP;
  if (outputTokens > 0 && outputTokens >= limit * 0.95) {
    return { truncated: true, reason: `output_tokens(${outputTokens}) >= 95% of limit(${limit})` };
  }

  // Heuristic: response ends mid-sentence or mid-code-block
  const text = response.reply || response.content || '';
  if (text.length >= TRUNCATION_SIGNAL_CHARS) {
    // Check for unclosed code blocks
    const codeBlockOpens = (text.match(/```/g) || []).length;
    if (codeBlockOpens % 2 !== 0) {
      return { truncated: true, reason: 'unclosed code block' };
    }
  }

  return { truncated: false };
}

/**
 * Determine the escalated output cap.
 *
 * @param {number} currentCap
 * @returns {number}
 */
function escalateCap(currentCap) {
  if (!currentCap || currentCap <= INITIAL_OUTPUT_CAP) {
    return ESCALATED_OUTPUT_CAP;
  }
  // Already escalated — no further increase
  return currentCap;
}

/**
 * Wrap a chat function with adaptive output escalation.
 *
 * @param {Function} chatFn - (message, options) => Promise<response>
 * @param {object} [config]
 * @param {number} [config.initialCap] - Starting output cap
 * @param {number} [config.maxRetries] - Max escalation retries (default: 1)
 * @returns {Function} Enhanced chat function
 */
function withAdaptiveOutput(chatFn, config = {}) {
  const initialCap = config.initialCap || INITIAL_OUTPUT_CAP;
  const maxRetries = config.maxRetries ?? 1;

  return async function adaptiveChat(message, options = {}) {
    let currentCap = options.max_tokens || initialCap;
    let retries = 0;

    while (true) {
      const response = await chatFn(message, { ...options, max_tokens: currentCap });

      const { truncated, reason } = detectTruncation(response, currentCap);

      if (!truncated || retries >= maxRetries) {
        // Attach escalation metadata
        if (response && retries > 0) {
          response._escalated = true;
          response._escalatedFrom = initialCap;
          response._escalatedTo = currentCap;
        }
        return response;
      }

      // Escalate
      const newCap = escalateCap(currentCap);
      if (newCap <= currentCap) {
        // Can't escalate further
        return response;
      }

      currentCap = newCap;
      retries++;

      // On retry, append continuation hint
      if (response && (response.reply || response.content)) {
        const partial = (response.reply || response.content).slice(-200);
        message = `${message}\n\n[SYSTEM: Previous response was truncated (${reason}). Continue from where you left off. Last content: ...${partial}]`;
      }
    }
  };
}

// ── Long-Running Command Advisory ──────────────────────────────────

const MIN_LONG_RUN_THRESHOLD_MS = 1000;

/**
 * Calculate the threshold at which a command should suggest background promotion.
 * @param {number} effectiveTimeoutMs
 * @returns {number}
 */
function longRunThreshold(effectiveTimeoutMs) {
  return Math.max(MIN_LONG_RUN_THRESHOLD_MS, Math.floor(effectiveTimeoutMs / 2));
}

/**
 * Create a long-run advisory timer for a shell command.
 *
 * @param {object} params
 * @param {number} params.timeoutMs - Effective command timeout
 * @param {string} params.command - The command being run
 * @param {Function} params.onAdvisory - (message) => void
 * @returns {{ clear: () => void }}
 */
function createLongRunAdvisory(params) {
  const threshold = longRunThreshold(params.timeoutMs);
  const handle = setTimeout(() => {
    const msg = `Command "${(params.command || '').slice(0, 60)}" has been running for ${Math.round(threshold / 1000)}s. ` +
      `Consider running it in the background to avoid timeout.`;
    try { params.onAdvisory(msg); } catch { /* ignore */ }
  }, threshold);

  if (handle.unref) handle.unref();

  return {
    clear() { clearTimeout(handle); },
  };
}

module.exports = {
  // Truncation detection & escalation
  detectTruncation,
  escalateCap,
  withAdaptiveOutput,
  INITIAL_OUTPUT_CAP,
  ESCALATED_OUTPUT_CAP,

  // Global timeout multiplier
  getTimeoutMultiplier,
  applyMultiplier,

  // Long-run advisory
  longRunThreshold,
  createLongRunAdvisory,
};
