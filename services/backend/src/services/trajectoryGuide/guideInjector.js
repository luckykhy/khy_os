'use strict';

/**
 * guideInjector.js — build a "recommended path" system-prompt block for WEAK
 * models (DESIGN-ARCH-049, capability B; locked decision: "context-injection" —
 * steer strongly, never hard-lock).
 *
 * Strictly gated:
 *   - returns null unless KHY_TRAJ_GUIDE_INJECT is on (env default off → zero
 *     regression, sp byte-identical when disabled);
 *   - returns null unless the executing model is WEAK (strong models don't need a
 *     map drawn for them — that's the whole point of capability C);
 *   - returns null when no relevant map is found (best-effort, never an error).
 *
 * Pure function — safe to call every turn. No model here: it only formats the
 * map that guideRetriever already selected. The wording is advisory ("you MAY
 * follow"), so the weak model is steered, not constrained.
 */

const config = require('./config');
const { assess } = require('../marshal/capabilityVector');
const guideRetriever = require('./guideRetriever');

/** Render the recommended-path block from a selected map, budget-capped. */
function _renderBlock(map, budgetChars) {
  const lines = [];
  lines.push('# Recommended Path (from a past successful trajectory)');
  lines.push('');
  lines.push(`A strong model previously solved a similar task ("${map.task}") along the path below.`);
  lines.push('You MAY follow these steps in order to reach the result with less trial-and-error.');
  lines.push('This is guidance, not a constraint: adapt freely, and verify your own results.');
  lines.push('');
  const steps = Array.isArray(map.steps) ? map.steps : [];
  for (const s of steps) {
    const note = s.tier === 'NETWORK_AI' ? '  (non-deterministic — use judgement)' : '';
    const line = `${(s.seq || 0) + 1}. ${s.intent}${note}`;
    // Budget guard: stop once we'd exceed the char budget (keep at least 1 step).
    if (lines.join('\n').length + line.length > budgetChars && steps.indexOf(s) > 0) {
      lines.push('   … (path truncated to fit the guidance budget)');
      break;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Build the guide block for the current turn, or null if not applicable.
 *
 * @param {object} args
 * @param {string} args.userMessage  the user's task text (retrieval query).
 * @param {string} args.modelId      the executing model id (weak-gated).
 * @param {boolean} [args.allowVector=false]  enable vector rerank in retrieval.
 * @returns {Promise<string|null>}
 */
async function buildGuideBlock(args = {}) {
  if (!config.isGuideInjectEnabled()) return null;
  const { userMessage, modelId } = args;
  if (!userMessage || !modelId) return null;

  // Weak-only: strong models author maps, they don't consume them.
  let strength;
  try { strength = assess(modelId).strength; } catch { return null; }
  if (strength !== 'weak') return null;

  let guide;
  try {
    guide = await guideRetriever.findGuide(String(userMessage), { allowVector: !!args.allowVector });
  } catch {
    return null; // best-effort: never break the turn
  }
  if (!guide || !guide.map) return null;

  return _renderBlock(guide.map, config.guideChars());
}

module.exports = { buildGuideBlock, _renderBlock };
