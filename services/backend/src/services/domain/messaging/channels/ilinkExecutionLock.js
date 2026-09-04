'use strict';

/**
 * ilinkExecutionLock.js — process-wide serial execution mutex for the ilink
 * (personal WeChat) channel.
 *
 * Why this exists: a single agent chat() run is non-reentrant and may take
 * minutes. When multiple accounts share one daemon, their dispatchers must not
 * run chat() concurrently — overlapping runs would interleave tool approvals
 * and corrupt per-run state. This module guarantees that, across ALL callers,
 * at most one fn executes at any instant.
 *
 * Implementation: a Promise-chain queue. Each runExclusive() call appends its
 * work to the tail of the chain and awaits its turn. Ordering is FIFO by call
 * time. Pure in-memory, no persistence.
 *
 * Contract: if fn throws (or rejects), the lock is still released and the
 * error is propagated to that caller unchanged; later queued callers proceed.
 *
 * @module services/channels/ilinkExecutionLock
 */

// Tail of the serial chain. Resolves once the currently-holding fn settles.
let _tail = Promise.resolve();
// Count of callers that have queued but not yet finished (for observability).
let _pending = 0;

/**
 * Run fn under the global serial lock. Blocks until all previously queued
 * callers have settled, then runs fn exclusively.
 * @template T
 * @param {() => (T|Promise<T>)} fn
 * @returns {Promise<T>} resolves/rejects with fn's result
 */
async function runExclusive(fn) {
  _pending += 1;
  // Capture the current tail as our gate, then extend the chain so the next
  // caller waits on us. The extended chain never rejects (release swallows),
  // so one caller's failure cannot poison the queue for others.
  const prior = _tail;
  let release;
  _tail = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await prior;
    return await fn();
  } finally {
    _pending -= 1;
    release();
  }
}

/** @returns {boolean} true when a fn is executing or callers are queued. */
function _isBusy() {
  return _pending > 0;
}

module.exports = {
  runExclusive,
  // exposed for tests
  _isBusy,
};
