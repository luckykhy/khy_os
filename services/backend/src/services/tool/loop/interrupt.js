'use strict';

/**
 * Tool-loop interrupt-behavior consumption family, extracted verbatim from
 * toolUseLoopCore.js (T-021 C3-P10). Pure leaf: the 4 helpers depend only on each
 * other + the shared INTERRUPT_BLOCK_MAX_MS_FALLBACK const, and their only external
 * reads are lazy sibling requires (tools registry / flagRegistry) — re-based one dir
 * deeper here, kept inside function bodies (no static require → off the R3 require-
 * graph SCC). No back-edge into the core, no managed<->managed cycle. The core
 * re-requires + re-exports all 4 names (public surface unchanged); the const is
 * family-private (never exported).
 */

// ── interruptBehavior consumption (tool-loop interrupt semantics) ────────────
// The declarative layer (_baseTool BEHAVIOR_DEFAULTS + registry passthrough) is
// complete; these helpers are the ONLY consumption point. A user interrupt
// cascades interruptSignal / external abort → parentAbort → per-tool abort
// signal at the executeTool sites. Tools declaring interruptBehavior 'block'
// get a DERIVED signal that withholds the abort until the running tool
// finishes, bounded by KHY_TOOL_INTERRUPT_BLOCK_MAX_MS; on timeout the derived
// signal aborts (forced cancel) and the result carries an honest CN notice.
// 'cancel' (default) / gate KHY_TOOL_INTERRUPT_BEHAVIOR off / no parent signal
// → the raw parent signal passes through verbatim (byte-identical).

// Fail-safe mirror of the flagRegistry spec default — used ONLY when the
// registry itself is unavailable. flagRegistry stays the single config source.
const INTERRUPT_BLOCK_MAX_MS_FALLBACK = 10000;

/**
 * Resolve a tool's declarative interruptBehavior from the registry — same
 * resolution pattern as the runtime isConcurrencySafe resolver. Unknown tool /
 * registry unavailable → 'cancel' (fail-closed to current behavior).
 * @param {string} name
 * @returns {'cancel'|'block'}
 */
function _resolveInterruptBehavior(name) {
  try {
    const reg = require('../../../tools');
    const rt = reg && typeof reg.get === 'function' ? reg.get(name) : null;
    return rt && rt.interruptBehavior === 'block' ? 'block' : 'cancel';
  } catch {
    return 'cancel';
  }
}

/**
 * User-facing CN notice for a block-wait that hit its upper bound.
 * Shape: action + target + progress (等待工具 X 完成超时(10s)，已强制中止).
 * @param {string} name @param {number} maxMs @returns {string}
 */
function _formatInterruptTimeoutNotice(name, maxMs) {
  const ms = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : INTERRUPT_BLOCK_MAX_MS_FALLBACK;
  const label = ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
  return `等待工具 ${name} 完成超时(${label})，已强制中止`;
}

/**
 * Build the per-call interrupt plan consumed at the executeTool sites.
 * Passthrough (plan.signal === parentSignal) when: no parent signal, gate
 * KHY_TOOL_INTERRUPT_BEHAVIOR off, or the tool declares 'cancel' — all three
 * keep the legacy cancel path byte-identical. For 'block': a derived
 * AbortController only aborts KHY_TOOL_INTERRUPT_BLOCK_MAX_MS after the parent
 * aborts, so the running tool gets a bounded grace window to finish. Every
 * wait has this upper bound; cleanup() must be called after the tool settles
 * to disarm the timer and detach the parent listener.
 * @param {string} name tool name
 * @param {AbortSignal|null} parentSignal parentAbort.signal or null (gated off)
 * @param {object} [env] env source (tests inject a hermetic object)
 * @param {(name:string)=>('cancel'|'block')} [resolveBehavior] injectable for tests
 * @returns {{signal:AbortSignal|null, maxMs:number, timedOut:()=>boolean, cleanup:()=>void}}
 */
function _buildToolInterruptPlan(
  name,
  parentSignal,
  env = process.env,
  resolveBehavior = _resolveInterruptBehavior
) {
  const passthrough = {
    signal: parentSignal,
    maxMs: 0,
    timedOut: () => false,
    cleanup: () => {},
  };
  try {
    if (!parentSignal) {
      return passthrough;
    }
    let gateOn = true;
    try {
      gateOn = require('../../flagRegistry').isFlagEnabled('KHY_TOOL_INTERRUPT_BEHAVIOR', env);
    } catch {
      gateOn = true;
    }
    if (!gateOn) {
      return passthrough;
    }
    if (resolveBehavior(name) !== 'block') {
      return passthrough;
    }
    let maxMs = INTERRUPT_BLOCK_MAX_MS_FALLBACK;
    try {
      maxMs = require('../../flagRegistry').resolveNumeric('KHY_TOOL_INTERRUPT_BLOCK_MAX_MS', env);
    } catch {
      maxMs = INTERRUPT_BLOCK_MAX_MS_FALLBACK;
    }
    const ac = new AbortController();
    let timer = null;
    let timedOut = false;
    const onParentAbort = () => {
      // Bounded grace window: let the running tool finish; force-cancel after maxMs.
      timer = setTimeout(() => {
        timedOut = true;
        try {
          ac.abort(_formatInterruptTimeoutNotice(name, maxMs));
        } catch {
          /* ignore */
        }
      }, maxMs);
      if (timer.unref) {
        timer.unref();
      }
    };
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    return {
      signal: ac.signal,
      maxMs,
      timedOut: () => timedOut,
      cleanup: () => {
        try {
          parentSignal.removeEventListener('abort', onParentAbort);
        } catch {
          /* ignore */
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  } catch {
    return passthrough;
  }
}

/**
 * Annotate a tool result after a block-wait timeout forced the cancel. The
 * notice always lands in _interruptTimeoutNotice; only FAILED results get it
 * appended to `error` — a tool that ignored the forced abort and still
 * succeeded keeps its honest success shape.
 * @param {*} result @param {string} name @param {number} maxMs @returns {*}
 */
function _annotateInterruptTimeout(result, name, maxMs) {
  const notice = _formatInterruptTimeoutNotice(name, maxMs);
  if (result && typeof result === 'object') {
    result._interruptTimeoutNotice = notice;
    if (!result.success) {
      result.error = result.error ? `${result.error}\n${notice}` : notice;
    }
    return result;
  }
  return result;
}

module.exports = { _resolveInterruptBehavior, _formatInterruptTimeoutNotice, _buildToolInterruptPlan, _annotateInterruptTimeout };
