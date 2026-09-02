'use strict';

/**
 * Deferred-status flush extracted from replSession.js (T-020 B5 first slice —
 * proves the array-by-reference pattern: the buffer array stays owned by the
 * caller and is passed in by reference, so push/splice semantics are identical
 * across the module boundary with zero ref-object conversion).
 *
 * Owns, verbatim from the former startRepl() closure: the flush that replays
 * statuses buffered while _busyStreaming once streaming ends — skipping stale
 * plans, low-value metric noise, and completion/connection confirmations, and
 * replaying the rest as dim 'done' step lines (infrastructure, not delivery).
 */

function createDeferredStatusFlush(deferredStatuses) {
  return function _flushDeferredStatuses() {
    if (deferredStatuses.length === 0) {
      return;
    }
    const batch = deferredStatuses.splice(0);
    // Plan is NOT shown here — it should have appeared before text, not after.
    // Only replay non-noise statuses that are still meaningful post-stream.
    const renderer = require('../aiRenderer');
    for (const s of batch) {
      // Skip plan (stale — text already shown), skip low-value infrastructure noise
      if (s.phase === 'plan') {
        continue;
      }
      if (/已自动优化|Metrics|metrics|档位/i.test(s.text)) {
        continue;
      }
      // Skip completion/connection confirmations — already obvious from the response
      if (/完成处理|已连接并响应|已连接|通道状态刷新/i.test(s.text)) {
        continue;
      }
      // Show remaining deferred statuses in dim white (infrastructure, not delivery)
      renderer.printStepLine('done', s.phase || '状态', '', s.text);
    }
  };
}

module.exports = { createDeferredStatusFlush };
