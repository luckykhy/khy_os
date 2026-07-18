'use strict';

/**
 * proactiveCollaboration — facade (DESIGN-ARCH-031).
 *
 * One entry point, `proposeCollaboration`, that the tool-use loop calls at the
 * iteration-1 "model returned no tool call" seam (next to auto-web-search and
 * auto-scaffold). It decides whether to proactively decompose a decomposable
 * multi-deliverable task and delegate the pieces to collaborating sub-agents,
 * and if so returns the orchestrated `agent` tool-call to inject.
 *
 * Guard rails (防呆) — every one of these must hold or the facade is a no-op:
 *   ① enabled .......... KHY_PROACTIVE_COLLAB env flag (default on)
 *   ② agent tool ........ the orchestrated `agent` tool must actually be in the
 *                         pool; otherwise the injected call would fail. (The
 *                         loop also gates on !_isSubagent so this never fires
 *                         inside a spawned agent, which would recurse.)
 *   ③ opportunity ....... the detector must find ≥MIN_SUBTASKS independent
 *                         deliverables above the confidence floor.
 *   ④ actionable plan ... the planner must produce a bounded tool-call.
 *
 * Fully fail-soft: any throw is swallowed and reported as a no-op so the caller
 * (the main loop) is never blocked. Pure aside from reading env via the caller.
 */

const { detectCollaborationOpportunity } = require('./opportunityDetector');
const { planDelegation } = require('./delegationPlanner');

/**
 * proposeCollaboration(message, opts) → {
 *   inject: boolean,
 *   toolCall: object | null,
 *   reason: string,
 *   subtaskCount: number,
 *   confidence: number,
 * }
 *
 * opts:
 *   enabled            (boolean)  — resolved KHY_PROACTIVE_COLLAB flag
 *   agentToolAvailable (boolean)  — is the `agent` tool in the active pool
 *   minConfidence      (number?)  — override the detector confidence floor
 */
function proposeCollaboration(message, opts = {}) {
  const noop = (reason) => ({ inject: false, toolCall: null, reason, subtaskCount: 0, confidence: 0 });

  try {
    if (opts.enabled === false) return noop('disabled by configuration');
    if (opts.agentToolAvailable === false) return noop('agent tool unavailable');

    const opportunity = detectCollaborationOpportunity(message, {
      minConfidence: opts.minConfidence,
    });
    if (!opportunity.shouldCollaborate) {
      return { ...noop(opportunity.reason), confidence: opportunity.confidence };
    }

    const plan = planDelegation(opportunity, { goal: message });
    if (!plan.toolCall) return noop('no actionable delegation plan');

    const droppedNote = plan.dropped > 0 ? ` (+${plan.dropped} folded by fan-out cap)` : '';
    return {
      inject: true,
      toolCall: plan.toolCall,
      reason: `proactively delegating ${plan.subtaskCount} sub-tasks to collaborating agents${droppedNote}`,
      subtaskCount: plan.subtaskCount,
      confidence: opportunity.confidence,
    };
  } catch (err) {
    return noop(`proactive collaboration error: ${err && err.message ? err.message : 'unknown'}`);
  }
}

module.exports = {
  proposeCollaboration,
  detectCollaborationOpportunity,
  planDelegation,
};
