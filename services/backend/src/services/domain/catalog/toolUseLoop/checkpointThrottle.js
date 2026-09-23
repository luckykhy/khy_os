'use strict';

/**
 * domain/catalog/toolUseLoop/checkpointThrottle.js — throttled onCheckpoint UI
 * projection, carved out of toolUseLoopCore.js runToolUseLoop main loop
 * (T-021 in-body slice #7, in-loop closure-state — same safe shape as the
 * iterationJournal slice #5: its one mutated variable, lastCheckpointTime, is
 * grep-proven used ONLY inside the block, so it moves entirely into the closure).
 *
 * Emits a checkpoint every 3 iterations OR whenever >45s elapsed since the last
 * emit, best-effort (the callback throw is swallowed and NEVER advances the
 * throttle timer in a way that changes control flow — the timer still advances,
 * matching the original). The caller owns the throttle start instant: the
 * factory is constructed at the same source position where `let
 * lastCheckpointTime = Date.now()` used to run, so Date.now() is captured at the
 * identical moment.
 *
 * In-body convention: ZERO static requires (nothing re-based); reads only the
 * deps passed per call + Date.now(). NO require back into toolUseLoopCore → M6
 * cycles stay 0. Pure side-effect is invoking the caller-supplied callback.
 */

function createCheckpointThrottle() {
  let lastCheckpointTime = Date.now(); // For onCheckpoint throttling

  function maybeCheckpoint(args = {}) {
    const { onCheckpoint, iteration, totalToolCalls, toolCallLog, fileReadHashes } = args;
    if (
      typeof onCheckpoint === 'function' &&
      (iteration % 3 === 0 || Date.now() - lastCheckpointTime > 45000)
    ) {
      try {
        onCheckpoint({
          iteration,
          totalToolCalls,
          toolCallLog: toolCallLog.slice(-20),
          fileReadHashes,
        });
      } catch {
        /* best-effort */
      }
      lastCheckpointTime = Date.now();
    }
  }

  return { maybeCheckpoint };
}

module.exports = { createCheckpointThrottle };
