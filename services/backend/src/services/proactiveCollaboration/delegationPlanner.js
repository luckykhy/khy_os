'use strict';

/**
 * proactiveCollaboration/delegationPlanner.js
 *
 * Pure transformation of a detected collaboration opportunity into a single,
 * bounded `agent` tool-call that fans the independent sub-tasks out to
 * collaborating sub-agents via the existing orchestrated path
 * (AgentTool → _runOrchestrated → SubAgentOrchestrator). The planner assigns a
 * role to each sub-task, clamps the fan-out to the configured ceiling, and
 * synthesizes a coordinator prompt. No I/O, no model calls.
 */

const { LIMITS, ROLE_SIGNALS, DEFAULT_ROLE } = require('./constants');

/** Infer the sub-agent role best suited to a sub-task from its action verbs. */
function inferRole(task) {
  const t = String(task || '');
  for (const bucket of ROLE_SIGNALS) {
    if (bucket.patterns.some(re => re.test(t))) return bucket.role;
  }
  return DEFAULT_ROLE;
}

/** Trim a sub-task description defensively. */
function _cleanTask(task) {
  return String(task || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LIMITS.MAX_SUBTASK_CHARS);
}

/**
 * planDelegation(opportunity, opts?) → {
 *   toolCall: { name: 'agent', params: { prompt, subtasks:[{task,role}], mode } } | null,
 *   subtaskCount: number,
 *   dropped: number,        // sub-tasks discarded by the fan-out clamp
 *   roles: string[],
 * }
 *
 * Returns toolCall=null when the opportunity is not actionable.
 */
function planDelegation(opportunity, opts = {}) {
  const goal = String(opts.goal || '').replace(/\s+/g, ' ').trim();
  const maxSubtasks = LIMITS.MAX_SUBTASKS;

  const raw = Array.isArray(opportunity && opportunity.subtasks) ? opportunity.subtasks : [];
  // Clean + de-dupe (defensive; detector already de-dupes).
  const seen = new Set();
  const cleaned = [];
  for (const st of raw) {
    const task = _cleanTask(st && st.task);
    const key = task.toLowerCase();
    if (!task || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(task);
  }

  if (cleaned.length < LIMITS.MIN_SUBTASKS) {
    return { toolCall: null, subtaskCount: 0, dropped: 0, roles: [] };
  }

  const kept = cleaned.slice(0, maxSubtasks);
  const dropped = cleaned.length - kept.length;

  const subtasks = kept.map(task => ({ task, role: inferRole(task) }));
  const roles = subtasks.map(s => s.role);

  // Coordinator prompt: states the overall goal and that the sub-tasks below are
  // being handled by collaborating agents whose results must be synthesized.
  const goalLine = goal
    ? `Overall goal: ${goal}`
    : 'Overall goal: complete all of the independent sub-tasks below.';
  const prompt = [
    goalLine,
    '',
    'These sub-tasks are independent and are being delegated to collaborating',
    'sub-agents running in parallel. Coordinate their work and synthesize the',
    'combined result into a single coherent deliverable.',
  ].join('\n');

  return {
    toolCall: {
      name: 'agent',
      params: {
        prompt,
        subtasks,
        mode: 'flexible',
      },
    },
    subtaskCount: subtasks.length,
    dropped,
    roles,
  };
}

module.exports = { planDelegation, inferRole, _cleanTask };
