'use strict';

/**
 * debugLog.js — opt-in stderr transition logger for shadow FSMs.
 *
 * attachDebugLog(fsm, label) assigns fsm.onStateChange ONLY when
 * `process.env.KHY_STATE_DEBUG === '1'`. When the flag is off, nothing is
 * assigned and the FSM stays byte-identical to today (zero output, zero
 * hook dispatch cost).
 *
 * The hook itself is dispatched by the FSM core via queueMicrotask and any
 * exception inside it is swallowed (see stateMachine/fsm.js contract), so
 * this logger can never break or slow down the host hot path.
 *
 * While the flag is on, each transition is also forwarded to the existing
 * diagnostic event bus (services/diagnosticEvents) as `fsm.phase_transition`
 * — fail-soft: a missing/broken bus never affects the stderr line.
 *
 * @module services/stateMachine/debugLog
 */

/**
 * Format a unix-ms timestamp as local HH:mm:ss.
 * @param {number} ts
 * @returns {string}
 */
function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Attach a stderr debug logger to an FSM instance when KHY_STATE_DEBUG=1.
 *
 * Line format (action + target + progress: from/to/event/time):
 *   [fsm:label] from → to (event, HH:mm:ss)
 *
 * @param {object|null} fsm - FSM instance (FiniteStateMachine or NoopFsm); null tolerated
 * @param {string} label - short machine label for the log prefix
 * @returns {boolean} true when the hook was attached
 */
function attachDebugLog(fsm, label) {
  if (!fsm || typeof fsm !== 'object') {
    return false;
  }
  let debugOn = false;
  try {
    debugOn = process.env.KHY_STATE_DEBUG === '1';
  } catch {
    return false;
  }
  if (!debugOn) {
    return false;
  } // flag off → do not assign, zero output

  const name = String(label || fsm.name || 'fsm');
  fsm.onStateChange = (from, to, event) => {
    const at = Date.now();
    try {
      process.stderr.write(`[fsm:${name}] ${from} \u2192 ${to} (${event}, ${formatTime(at)})\n`);
    } catch {
      /* stderr unavailable → drop the line, never throw */
    }
    try {
      // Reuse the existing diagnostic bus; never create a new one here.
      const { diagnostics } = require('../diagnosticEvents');
      diagnostics.emit('fsm.phase_transition', { fsm: name, from, to, event, at });
    } catch {
      /* bus optional → stderr line already written */
    }
  };
  return true;
}

module.exports = { attachDebugLog, formatTime };
