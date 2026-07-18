'use strict';

/**
 * _streamHealthSink.js — a zero-dependency inversion seam for stream-health
 * telemetry.
 *
 * Why this exists: the low-level SSE stale detector (`_streamStaleDetector`)
 * used to reach UP into the `telemetryService` singleton on every stream stop
 * to record a best-effort health metric. That single lazy borrow tethered the
 * whole gateway adapter cluster (every SSE stream + cursor/kiro/trae/windsurf/
 * vscode/relay adapters + the protocol pipeline + web-search interceptor) into
 * the backend's giant dependency SCC: a 213-line stream watchdog had no
 * business depending on the 883-line metrics aggregator.
 *
 * Inverting the direction fixes both the layering and the cycle: the detector
 * now EMITS into this neutral leaf, and `telemetryService` REGISTERS itself as
 * the sink when it loads. The detector no longer knows telemetry exists; the
 * giant SCC shrinks 77 -> 63 ([DESIGN-ARCH-051] §6.4).
 *
 * Contract (unchanged best-effort semantics): emission is non-blocking and
 * never throws. When no sink is registered yet, `emitStreamHealth` is a silent
 * no-op — exactly the pre-existing "telemetry unavailable" fallthrough. In any
 * real session telemetryService is loaded at startup (serviceRegistry /
 * toolUseLoop / router all pull it), so the sink is registered long before any
 * stream stops; the only observable difference from the old lazy-require is the
 * contrived path where telemetry is never loaded at all, in which case the
 * metric is dropped (it was already only written to an in-memory counter that
 * such a path never reads).
 *
 * Note: this file DELIBERATELY contains no require-call syntax (even in
 * comments). The backend arch-debt scanner matches that syntax line-by-line
 * without stripping comments, and a phantom edge here would re-pull the leaf
 * into the SCC (same trap documented in §6.2 / §6.3).
 *
 * Discipline: zero dependencies, no I/O, single module-level slot, never throws.
 */

let _sink = null;

/**
 * Register (or clear) the stream-health telemetry sink.
 * @param {(payload: object) => void | null} fn  A sink function, or null/non-function to clear.
 */
function setStreamHealthSink(fn) {
  _sink = typeof fn === 'function' ? fn : null;
}

/**
 * Emit a stream-health payload to the registered sink, best-effort.
 * No-op (returns false) when no sink is registered. Never throws.
 * @param {object} payload
 * @returns {boolean} true if a sink consumed the payload without throwing.
 */
function emitStreamHealth(payload) {
  if (!_sink) return false;
  try {
    _sink(payload);
    return true;
  } catch {
    return false;
  }
}

module.exports = { setStreamHealthSink, emitStreamHealth };
