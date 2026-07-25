'use strict';

/**
 * orchestrationFlow.js — Hardened-SOP driver for multi-subtask orchestration (B2).
 *
 * Purpose: wire the otherwise-orphan `flowsEngine.js` state machine into the
 * AgentTool orchestration path so a run can opt into a *hardened* (auditable,
 * strictly-sequential SOP) execution mode instead of the default *flexible*
 * (concurrent AI fan-out via SubAgentOrchestrator).
 *
 * Mode semantics (one FlowStep per subtask):
 *   - hardened  : run strictly in declared order; every step is recorded in the
 *                 flow history (固化 SOP). A failed hardened step fails the flow.
 *   - flexible  : still run in sequence here, but the step is handed back to the
 *                 AgentTool's AI executor (the same callback used by the
 *                 concurrent path) — the SOP only fixes *ordering*, not judgement.
 *   - human-gate: reuse flowsEngine's built-in WAITING gate (`canEnter`) +
 *                 `signal()` resume. The flow parks until the gate is released;
 *                 no new interruption mechanism is introduced.
 *
 * This module is a thin adapter: it owns NO execution logic of its own. The
 * caller supplies `executeSubtask(subtask, index)` (the bridge to a real agent
 * run) and, optionally, `isGateReleased(subtask, index)` to decide whether a
 * human-gate may proceed. It returns a summary shaped exactly like
 * `SubAgentOrchestrator.summarize()` so the same orchestration rollup receipt
 * (B1) can be persisted regardless of which mode ran.
 *
 * Zero hardcoding: step types derive from `riskGate.deriveStepType` when not
 * declared; no host/port/path constants. State transparency: every step's
 * type/risk/status lands in the flow history and the returned summary.
 */

const { FlowInstance, FLOW_STATE } = require('./flowsEngine');

let _riskGate = null;
function riskGate() {
  if (!_riskGate) {
    try { _riskGate = require('./riskGate'); } catch { _riskGate = {}; }
  }
  return _riskGate;
}

const VALID_STEP_TYPES = new Set(['hardened', 'flexible', 'human-gate']);

/**
 * Resolve the step type for a subtask. Explicit `stepType` wins; otherwise it is
 * derived from the subtask's risk signals via riskGate, falling back to
 * 'hardened' (the conservative, ordered default for an SOP run).
 *
 * @param {object} subtask
 * @param {string} [runMode] - run-level mode ('hardened'|'mixed'|'flexible')
 * @returns {string} one of VALID_STEP_TYPES
 */
function resolveStepType(subtask = {}, runMode = 'hardened') {
  if (subtask.stepType && VALID_STEP_TYPES.has(subtask.stepType)) {
    return subtask.stepType;
  }
  const rg = riskGate();
  if (typeof rg.deriveStepType === 'function') {
    try {
      const t = rg.deriveStepType({
        risk: subtask.risk,
        isReadOnly: !!subtask.isReadOnly,
        isDestructive: !!subtask.isDestructive,
      });
      if (VALID_STEP_TYPES.has(t)) return t;
    } catch { /* fall through */ }
  }
  // Mixed mode leaves underived steps flexible; hardened mode pins them hardened.
  return runMode === 'flexible' ? 'flexible' : (runMode === 'mixed' ? 'flexible' : 'hardened');
}

/**
 * Build a FlowDefinition from an ordered subtask list.
 *
 * Each subtask becomes a single step `step-<i>` chained to `step-<i+1>`. The
 * step's `execute` invokes the caller-provided `executeSubtask`, measures its
 * own wall-clock duration, and records the structured result into the shared
 * `state.results[]` array (kept on the closure, not the flow context, to avoid
 * bloating the serialized context). human-gate steps additionally carry a
 * `canEnter` gate that parks the flow in WAITING until released.
 *
 * @param {object[]} subtasks
 * @param {object} state - mutable run state (results, timings, executors, types)
 * @param {function} executeSubtask - (subtask, index) => Promise<result>
 * @param {function} [isGateReleased] - (subtask, index) => boolean
 * @param {string} runMode
 * @returns {{ id, name, steps, entryStep }}
 */
function _buildDefinition(subtasks, state, executeSubtask, isGateReleased, runMode) {
  const steps = subtasks.map((subtask, index) => {
    const stepId = `step-${index}`;
    const isLast = index === subtasks.length - 1;
    const stepType = resolveStepType(subtask, runMode);
    const risk = subtask.risk || 'medium';
    const executor = subtask.executor || subtask.role || 'unknown';

    state.types[index] = stepType;
    state.executors[index] = executor;

    const step = {
      id: stepId,
      name: subtask.name || `subtask-${index + 1}`,
      type: stepType,
      risk,
      next: isLast ? null : `step-${index + 1}`,
      async execute(context) {
        const startTs = Date.now();
        try {
          const result = await executeSubtask(subtask, index);
          state.results[index] = result;
          state.timings[index] = Date.now() - startTs;
          state.statuses[index] = (result && result.success === false) ? 'failed' : 'completed';
          if (state.statuses[index] === 'failed') {
            // A failed hardened step fails the SOP (strict ordering contract).
            // A flexible step's failure is non-fatal: the run continues so the
            // remaining steps still get their chance (AI fan-out semantics).
            if (stepType === 'hardened') {
              return { status: 'fail', error: (result && result.error) || 'hardened step failed' };
            }
          }
          return { status: isLast ? 'complete' : 'continue' };
        } catch (err) {
          state.results[index] = { success: false, error: err.message };
          state.timings[index] = Date.now() - startTs;
          state.statuses[index] = 'failed';
          if (stepType === 'hardened') {
            return { status: 'fail', error: err.message };
          }
          return { status: isLast ? 'complete' : 'continue' };
        }
      },
    };

    if (stepType === 'human-gate') {
      // The flow parks in WAITING until the gate is released. By default the
      // gate consults the caller's `isGateReleased`; absent that, it reads a
      // per-step flag merged into context by `signal({ released: {...} })`.
      step.canEnter = (context) => {
        if (typeof isGateReleased === 'function') {
          try { return !!isGateReleased(subtask, index); } catch { return false; }
        }
        return !!(context && context.released && context.released[stepId]);
      };
    }

    return step;
  });

  return {
    id: 'orchestration-sop',
    name: 'Orchestration SOP',
    steps,
    entryStep: steps.length ? steps[0].id : null,
  };
}

/**
 * Build a summary shaped like SubAgentOrchestrator.summarize() so the B1
 * orchestration rollup receipt can be persisted identically for both modes.
 *
 * @param {object[]} subtasks
 * @param {object} state
 * @returns {object}
 */
function _buildSummary(subtasks, state) {
  const byStepType = {};
  const byExecutor = {};
  const out = [];
  let successCount = 0;
  let failCount = 0;
  let totalDurationMs = 0;

  for (let i = 0; i < subtasks.length; i++) {
    const stepType = state.types[i] || 'hardened';
    const executor = state.executors[i] || 'unknown';
    const durationMs = state.timings[i] || 0;
    // A step that never ran (flow parked/failed before reaching it) stays 'skipped'.
    const status = state.statuses[i] || 'skipped';

    byStepType[stepType] = (byStepType[stepType] || 0) + 1;
    byExecutor[executor] = (byExecutor[executor] || 0) + 1;
    totalDurationMs += durationMs;
    if (status === 'completed') successCount++;
    else if (status === 'failed') failCount++;

    out.push({
      id: `step-${i}`,
      name: (subtasks[i] && subtasks[i].name) || `subtask-${i + 1}`,
      executor,
      stepType,
      durationMs,
      status,
    });
  }

  return {
    subtaskCount: subtasks.length,
    successCount,
    failCount,
    totalDurationMs,
    byStepType,
    byExecutor,
    subtasks: out,
  };
}

/**
 * Run an ordered subtask list as a hardened/mixed SOP flow.
 *
 * @param {object} opts
 * @param {object[]} opts.subtasks - ordered subtasks ({ prompt, role, executor,
 *   stepType?, risk?, name?, isReadOnly?, isDestructive? })
 * @param {function} opts.executeSubtask - (subtask, index) => Promise<result>;
 *   result is the structured agent output ({ success, text, error, ... }).
 * @param {function} [opts.isGateReleased] - (subtask, index) => boolean gate test
 *   for human-gate steps (absent → park in WAITING until signal()).
 * @param {string} [opts.mode='hardened'] - run-level mode ('hardened'|'mixed').
 * @param {object} [opts.initialContext] - seed context for the flow.
 * @returns {Promise<{
 *   state: string, waiting: boolean, history: object[], results: any[],
 *   summary: object, instance: FlowInstance
 * }>}
 */
async function runHardenedFlow(opts = {}) {
  const subtasks = Array.isArray(opts.subtasks) ? opts.subtasks : [];
  const executeSubtask = typeof opts.executeSubtask === 'function'
    ? opts.executeSubtask
    : async () => ({ success: false, error: 'no executeSubtask provided' });
  const runMode = opts.mode === 'mixed' ? 'mixed' : 'hardened';

  // Shared mutable run state — kept off the serialized flow context.
  const state = {
    results: new Array(subtasks.length).fill(null),
    timings: new Array(subtasks.length).fill(0),
    statuses: new Array(subtasks.length).fill(null),
    types: new Array(subtasks.length).fill(null),
    executors: new Array(subtasks.length).fill(null),
  };

  if (subtasks.length === 0) {
    return {
      state: FLOW_STATE.COMPLETED,
      waiting: false,
      history: [],
      results: [],
      summary: _buildSummary(subtasks, state),
      instance: null,
    };
  }

  const definition = _buildDefinition(
    subtasks, state, executeSubtask, opts.isGateReleased, runMode
  );
  const instance = new FlowInstance(definition, opts.initialContext || {});

  const outcome = await instance.run();

  return {
    state: outcome.state,
    waiting: outcome.state === FLOW_STATE.WAITING,
    history: instance.history,
    results: state.results,
    summary: _buildSummary(subtasks, state),
    instance,
  };
}

module.exports = {
  runHardenedFlow,
  resolveStepType,
  // Exposed for unit testing the pure derivation/summary helpers.
  _buildSummary,
  _buildDefinition,
};
