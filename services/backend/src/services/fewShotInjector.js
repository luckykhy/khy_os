'use strict';

/**
 * fewShotInjector.js — Stage 3.5 of the small-model normalization pipeline:
 * few-shot tool-use example injection for weak-tier (T3) models.
 *
 * Decides whether the current request qualifies for few-shot demonstration
 * turns and, if so, splices them into the model-bound structured message
 * array right after the leading system message(s) and before the real
 * conversation history. The input array is NEVER mutated and nothing is
 * written back into persisted session history — only the copy sent to the
 * model carries the examples.
 *
 * Gating conditions (all must hold):
 *   1. flag KHY_SMALL_MODEL_FEW_SHOT enabled (flagRegistry, default-on);
 *   2. resolveTier(modelId) === 'T3' (weak models only);
 *   3. real user turns in history <= max-turn threshold (early conversation
 *      only, to avoid token waste in long sessions);
 *   4. getFewShotCount(tier) > 0 and the template pool returns messages;
 *   5. NOT a lightweight/small chat turn (greeting/joke/story/self-intro or
 *      taskScale=small; gate KHY_SMALL_MODEL_FEW_SHOT_SKIP_SMALL, default-on).
 *      Weak models read the demo tasks as pending work on casual turns
 *      ("讲个故事" → invented a "Node.js 22 LTS" task and wrote files), so the
 *      demos are withheld exactly where they are never needed.
 *
 * Fail-soft: any require failure or thrown error inside the decision chain
 * silently results in "no injection" — this module must never break a chat.
 *
 * Pure leaf besides lazy same-package requires: no IO, no state, no throws.
 *
 * @module services/fewShotInjector
 */

// Default max user-turn count that still qualifies for injection.
// Env override: KHY_SMALL_MODEL_FEW_SHOT_MAX_TURN (non-negative integer).
const FEW_SHOT_MAX_TURN_DEFAULT = 2;

// Messages per example group in smallModelPromptTemplates (user task →
// assistant tool call → user tool result → assistant wrap-up).
const MESSAGES_PER_EXAMPLE_GROUP = 4;

// System note spliced ahead of the demo turns. Prompt-side scaffolding text is
// Chinese (project convention); the note travels with the model-bound copy only
// and is never persisted into session history.
const FEW_SHOT_DEMO_NOTE =
  '[系统] 以下若干轮对话是工具调用格式的演示示例，均为虚构，不是本轮的真实任务，不要执行它们，也不要把它们当作待办；本轮真实任务在示例之后的 user 消息里。';

/**
 * Resolve the max-turn threshold (env-overridable, never throws).
 * @param {object} [env] - Defaults to process.env
 * @returns {number}
 */
function getFewShotMaxTurn(env = process.env) {
  const raw = String((env && env.KHY_SMALL_MODEL_FEW_SHOT_MAX_TURN) || '').trim();
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : FEW_SHOT_MAX_TURN_DEFAULT;
}

// Whether few-shot demos are withheld on lightweight/small chat turns.
// Default ON: demo user-turns read as pending work to weak models on casual
// turns, which is where they can only do harm. Env override:
// KHY_SMALL_MODEL_FEW_SHOT_SKIP_SMALL (0/false/off/no restores injection).
function getSkipSmallTurns(env = process.env) {
  const raw = String((env && env.KHY_SMALL_MODEL_FEW_SHOT_SKIP_SMALL) || '')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * Count real user turns in a raw history array. User messages whose content
 * is an array are tool_result carrier blocks, not conversational turns, so
 * they are excluded (same for role 'tool').
 * @param {Array} historyMessages
 * @returns {number}
 */
function countUserTurns(historyMessages) {
  if (!Array.isArray(historyMessages)) {
    return 0;
  }
  let turns = 0;
  for (const msg of historyMessages) {
    if (!msg || msg.role !== 'user') {
      continue;
    }
    if (Array.isArray(msg.content)) {
      continue;
    }
    turns += 1;
  }
  return turns;
}

/**
 * Evaluate gating conditions and build the flat few-shot example messages.
 * Never throws; every failure path returns a "skip" result.
 *
 * @param {object} [opts]
 * @param {string} [opts.modelId] - Preferred model id (tier resolution input)
 * @param {Array}  [opts.historyMessages] - Raw conversation history (turn count)
 * @param {string} [opts.taskType] - 'code'|'analysis'|'dataFetch'|'general'
 * @param {object} [opts.env] - Defaults to process.env
 * @returns {{injected: boolean, examples: Array<{role: string, content: string}>, tier: string|null, groups: number, taskType: string}}
 */
function buildFewShotExamples(opts = {}) {
  const taskType = typeof opts.taskType === 'string' && opts.taskType ? opts.taskType : 'general';
  const skip = { injected: false, examples: [], tier: null, groups: 0, taskType };
  try {
    const env = opts.env || process.env;

    const { isFlagEnabled } = require('./flagRegistry');
    if (!isFlagEnabled('KHY_SMALL_MODEL_FEW_SHOT', env)) {
      return skip;
    }

    const { resolveTier } = require('./modelTier');
    const tier = resolveTier(opts.modelId);
    if (tier !== 'T3') {
      return skip;
    }

    // Lightweight chat turns (greeting/joke/story/self-intro) and other small
    // turns never need tool-call demos — and demos are actively harmful there:
    // weak models treat the demo tasks as their own pending work. See module doc.
    if (opts.lightweightConversation === true) {
      return skip;
    }
    if (getSkipSmallTurns(env) && String(opts.taskScale || '').trim().toLowerCase() === 'small') {
      return skip;
    }

    if (countUserTurns(opts.historyMessages) > getFewShotMaxTurn(env)) {
      return skip;
    }

    const { getFewShotCount } = require('../constants/smallModelDefaults');
    const count = getFewShotCount(tier, env);
    if (!Number.isInteger(count) || count <= 0) {
      return skip;
    }

    const { getFewShotExamples } = require('./smallModelPromptTemplates');
    const examples = getFewShotExamples(taskType, count);
    if (!Array.isArray(examples) || examples.length === 0) {
      return skip;
    }

    const groups = Math.max(1, Math.round(examples.length / MESSAGES_PER_EXAMPLE_GROUP));
    return { injected: true, examples, tier, groups, taskType };
  } catch {
    return skip; // fail-soft: few-shot is an enhancement, never a blocker
  }
}

/**
 * Inject few-shot demonstration turns into a model-bound structured message
 * array (system first, then history). Returns a NEW array when injection
 * happens; the input array is never mutated, so persisted history stays clean.
 *
 * @param {Array<{role: string, content: *}>} structuredMessages - Model-bound array
 * @param {object} [opts] - See buildFewShotExamples, plus:
 * @param {function(string): void} [opts.onLog] - Optional log sink for the injection line
 * @returns {{messages: Array, injected: boolean, count: number, groups: number, tier: string|null}}
 */
function injectFewShotExamples(structuredMessages, opts = {}) {
  const base = Array.isArray(structuredMessages) ? structuredMessages : [];
  const built = buildFewShotExamples(opts);
  if (!built.injected) {
    return { messages: base, injected: false, count: 0, groups: 0, tier: built.tier };
  }

  // Splice right after the leading system message(s), before real history.
  // One leading system note labels the demo turns as fictional: weak models
  // otherwise read the demo tasks as this turn's pending work and start
  // executing them (session 2deaa521, 2026-09). Inserted at splice time, so
  // the examples array and MESSAGES_PER_EXAMPLE_GROUP bookkeeping stay intact.
  let splitAt = 0;
  while (splitAt < base.length && base[splitAt] && base[splitAt].role === 'system') {
    splitAt += 1;
  }
  const messages = [
    ...base.slice(0, splitAt),
    { role: 'system', content: FEW_SHOT_DEMO_NOTE },
    ...built.examples,
    ...base.slice(splitAt),
  ];

  if (typeof opts.onLog === 'function') {
    try {
      opts.onLog(
        `few-shot 注入: ${built.tier} 模型 ${String(opts.modelId || '(auto)')}，` +
          `任务类型 ${built.taskType}，${built.groups} 组示例（${built.examples.length} 条消息）`
      );
    } catch {
      /* logging is best effort */
    }
  }

  return {
    messages,
    injected: true,
    count: built.examples.length,
    groups: built.groups,
    tier: built.tier,
  };
}

module.exports = {
  FEW_SHOT_MAX_TURN_DEFAULT,
  MESSAGES_PER_EXAMPLE_GROUP,
  getFewShotMaxTurn,
  getSkipSmallTurns,
  countUserTurns,
  buildFewShotExamples,
  injectFewShotExamples,
};
