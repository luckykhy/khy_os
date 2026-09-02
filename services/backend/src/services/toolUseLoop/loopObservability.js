'use strict';

/**
 * Loop observability wiring extracted from runToolUseLoop
 * (T-021 C3-P1 first slice — proves the mutation-capture extraction pattern).
 *
 * Owns, verbatim from the former loop body:
 *   - shadow FSM creation (observation only, fail-soft, may be null)
 *   - v2 phase notification port: chains options.onPhase onto the FSM's
 *     onStateChange slot, preserving any previously attached hook
 *     (KHY_STATE_DEBUG attachDebugLog) — two consumers never override each other
 *   - fork-phase wrapper: AskUserQuestion / shell approval / hook approval
 *     forks all funnel through onControlRequest; wrapping at the entry emits
 *     {kind:'fork'} / {kind:'fork_clear'} around every handler await
 *
 * Mutation-capture pattern: the loop's current iteration counter is exposed as
 * `iterationRef` ({ current: number }). The onPhase hook reads `iterationRef.current`
 * at fire time — identical semantics to the former closure variable, with the
 * loop mutating `_iterationRef.current = iteration` each round. Never snapshot
 * the number into the hook.
 */

function setupLoopObservability({ onPhase, createLoopFsm }) {
  const loopFsm = createLoopFsm('toolLoop');

  const iterationRef = { current: 0 };
  if (loopFsm && typeof onPhase === 'function') {
    const prevPhaseHook = loopFsm.onStateChange;
    loopFsm.onStateChange = (from, to, event, meta) => {
      if (typeof prevPhaseHook === 'function') {
        try {
          prevPhaseHook(from, to, event, meta);
        } catch {
          /* prev hook owns its own error contract */
        }
      }
      try {
        onPhase({ from, to, event, iteration: iterationRef.current, at: Date.now() });
      } catch {
        /* observer must never break the loop */
      }
    };
  }

  const emitLoopPhaseEvent =
    typeof onPhase === 'function'
      ? (payload) => {
          try {
            onPhase(payload);
          } catch {
            /* observer only */
          }
        }
      : null;

  const wrapForkPhase = (handler) => {
    if (typeof handler !== 'function' || !emitLoopPhaseEvent) {
      return handler;
    }
    return async (controlRequest) => {
      const subtype = controlRequest && controlRequest.request && controlRequest.request.subtype;
      emitLoopPhaseEvent({
        kind: 'fork',
        fork: subtype === 'can_use_tool' ? 'permission' : 'ask_user',
        at: Date.now(),
      });
      try {
        return await handler(controlRequest);
      } finally {
        emitLoopPhaseEvent({ kind: 'fork_clear', at: Date.now() });
      }
    };
  };

  return { loopFsm, iterationRef, emitLoopPhaseEvent, wrapForkPhase };
}

module.exports = { setupLoopObservability };
