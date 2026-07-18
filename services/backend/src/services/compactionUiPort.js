'use strict';

/**
 * compactionUiPort.js — neutral port for HUD / compaction-lifecycle UI feedback.
 * Breaks reverse edges of the giant SCC across batches 2 and 3 (DESIGN-ARCH-021):
 *
 *   Batch 2:
 *   - services/contextCompressor.js → cli/aiRenderer.js  (printCompactionResult)
 *   - services/query/compactPipeline.js → cli/hudRenderer.js (setCompacting/clearCompacting)
 *   Batch 3:
 *   - services/toolCalling.js → cli/hudRenderer.js (updateTodos)
 *
 * All are one-way "service progress → terminal UI" notifications. The CLI
 * renderers self-register their callbacks on load (legit cli → services
 * direction); the services layer emits through this port. When nothing is
 * registered (headless service / test), every emit is a silent no-op — exactly
 * the degrade the prior `try { require(...) } catch {}` call sites provided.
 * This port is the single seam for cli/hudRenderer signals, so the HUD is never
 * wired through two competing ports.
 *
 * Zero dependencies — a true leaf, so it can never participate in a cycle.
 * Same範式 as sessionSourcePort / commandDispatchPort.
 */

let _resultRenderer = null;   // (data) => void                     from cli/aiRenderer
let _hudSignals = null;       // { setCompacting, clearCompacting }  from cli/hudRenderer
let _todoRenderer = null;     // (todos) => void                    from cli/hudRenderer

// ── #1 compaction result render (cli/aiRenderer.printCompactionResult) ──

/** Register the compaction-result renderer. Called by cli/aiRenderer on load. */
function registerCompactionResultRenderer(fn) {
  _resultRenderer = typeof fn === 'function' ? fn : null;
}

/**
 * Emit a completed-compaction result to the terminal, if a renderer is present.
 * @param {{ beforeTokens:number, afterTokens:number, durationMs:number }} data
 * @returns {boolean} true if rendered, false if degraded (no renderer / threw).
 */
function emitCompactionResult(data) {
  if (!_resultRenderer) return false;
  try { _resultRenderer(data); return true; } catch { return false; }
}

// ── #2 HUD compacting state (cli/hudRenderer.setCompacting/clearCompacting) ──

/** Register HUD compaction signals. Called by cli/hudRenderer on load. */
function registerHudCompactionSignals(signals) {
  _hudSignals = signals && typeof signals.setCompacting === 'function'
    && typeof signals.clearCompacting === 'function' ? signals : null;
}

/** Signal the HUD that compaction is starting. Silent no-op if unregistered. */
function signalCompactingStart(tokensBefore) {
  if (!_hudSignals) return false;
  try { _hudSignals.setCompacting(tokensBefore); return true; } catch { return false; }
}

/** Signal the HUD that compaction has finished. Silent no-op if unregistered. */
function signalCompactingDone() {
  if (!_hudSignals) return false;
  try { _hudSignals.clearCompacting(); return true; } catch { return false; }
}

// ── #3 HUD todo list (cli/hudRenderer.updateTodos) — Batch 3 ──

/** Register the HUD todo renderer. Called by cli/hudRenderer on load. */
function registerHudTodoRenderer(fn) {
  _todoRenderer = typeof fn === 'function' ? fn : null;
}

/**
 * Push an updated todo list to the HUD. Silent no-op if unregistered / throws.
 * @param {Array<{text:string, done:boolean}>} todos
 * @returns {boolean} true if rendered, false if degraded.
 */
function emitTodoUpdate(todos) {
  if (!_todoRenderer) return false;
  try { _todoRenderer(todos); return true; } catch { return false; }
}

/** @internal Reset registrations for testing. */
function _resetForTest() {
  _resultRenderer = null;
  _hudSignals = null;
  _todoRenderer = null;
}

module.exports = {
  registerCompactionResultRenderer,
  emitCompactionResult,
  registerHudCompactionSignals,
  signalCompactingStart,
  signalCompactingDone,
  registerHudTodoRenderer,
  emitTodoUpdate,
  _resetForTest,
};
