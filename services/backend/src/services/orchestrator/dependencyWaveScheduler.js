'use strict';

// @leaf
// Dependency-aware WAVE scheduler for auto-decomposed subtasks (farewell gift).
//
// WHY THIS EXISTS (deep-dig finding — a dead field + a severed bridge):
//   khy already decomposes a goal into subtasks and fans them out in parallel via
//   AgentTool._runOrchestrated. But the "ordered" half of "拆任务 → 有序并行" was
//   silently lost:
//     * _llmDecomposer.js DOES emit per-subtask `dependencies: [...]` (the LLM is
//       prompted for cross-subtask order and the parser keeps the field).
//     * orchestrationPlan.js DOES consume dependency edges downstream.
//     * BUT taskDecomposer's deterministic strategies emit only {prompt, role,
//       originIndex} — no deps — and _runOrchestrated forks EVERY subtask at once,
//       ignoring any `dependencies`. So the field _llmDecomposer spends tokens to
//       produce has NO consumer: an ordered chain (explore → implement → verify)
//       gets flattened into one unordered parallel burst — implement/verify race
//       ahead before explore has produced anything.
//
//   This leaf is the missing consumer. Given subtasks that MAY carry
//   `dependencies`, it compiles them into ordered execution WAVES: within a wave
//   the subtasks are mutually independent (safe to run in parallel), and waves run
//   strictly one after another. The thin wiring in agenticHarnessService runs each
//   wave through the EXISTING parallel primitive (_runOrchestrated) — this leaf
//   adds ZERO new execution machinery, only the ordering the dependencies imply.
//
// Design: PURE LEAF (纯叶子) — zero IO, no Date.now/Math.random, never throws.
// `planWaves(subtasks, opts)` is deterministic and replays byte-identically. Any malformed input, cycle,
// or internal error degrades CONSERVATIVELY to a single all-parallel wave (never
// stall on a bad edge). Gated `KHY_DEP_WAVE_SCHEDULE` default-on (0/false/off/no →
// byte-revert: single wave = exactly today's flat fan-out behavior).
//
// HOW-TO-EXTEND: to teach a new dependency-reference syntax, extend `_normalizeDeps`
// (it already accepts numeric index, `t<n>` id, and title/role string match); keep
// it pure and keep the "unknown reference → drop the edge, flag hadDanglingDeps"
// conservative rule so a bad spec can never deadlock the run. Add a node:test case
// for the new syntax + a regression asserting the flat/cycle fallbacks still hold.

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// Gate: default-on. Only 0/false/off/no disable. Read env directly (sibling gate;
// not registered in flagRegistry, which would return default-on and ignore 'off').
function _gateEnabled(env) {
  const v = (env || {}).KHY_DEP_WAVE_SCHEDULE;
  if (v === undefined || v === null) return true;
  return !_FALSY.has(String(v).trim().toLowerCase());
}

/** Safe string coercion (null/undefined → ''), never throws. */
function _asText(v) {
  if (v == null) return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

/**
 * Build a single all-parallel wave from the given subtasks (the conservative /
 * byte-revert result). Always returns the subtasks in their original array order.
 *
 * Additive keys for fault-aware execution (see partitionWaveBySurvivors): a flat
 * result carries NO resolved edges (`edges` = N empty Sets) so the fault-stop
 * partition is a guaranteed no-op — a single flat wave can never skip anything.
 * `waveGlobalIndex` mirrors the single wave's source positions.
 */
function _flatResult(subtasks, reason) {
  const n = Array.isArray(subtasks) ? subtasks.length : 0;
  return {
    ok: true,
    waves: n ? [subtasks.slice()] : [],
    waveCount: n ? 1 : 0,
    reason,
    hadDanglingDeps: false,
    edges: Array.from({ length: n }, () => new Set()),
    waveGlobalIndex: n ? [Array.from({ length: n }, (_, i) => i)] : [],
  };
}

/**
 * Resolve one subtask's raw `dependencies` list into a Set of concrete node ids
 * ("t1", "t2", …) referencing OTHER subtasks. Accepts, per reference:
 *   * a number            → 1-based index into subtasks (also tolerates originIndex)
 *   * "t<n>"              → a node id directly
 *   * any other string    → matched against another subtask's title/name/role/prompt
 * Self-references and references that resolve to no known node are dropped by the
 * caller (which also flags hadDanglingDeps). Pure, never throws.
 *
 * @param {*} rawDeps          the subtask's `dependencies` field (any shape)
 * @param {number} selfIdx     this subtask's 0-based position
 * @param {Array} normalized   [{id, idx, keys:Set<string>}] for all subtasks
 * @returns {{ids:Set<string>, dangling:boolean}}
 */
function _normalizeDeps(rawDeps, selfIdx, normalized) {
  const ids = new Set();
  let dangling = false;
  if (!Array.isArray(rawDeps) || rawDeps.length === 0) return { ids, dangling };

  for (const ref of rawDeps) {
    let matchIdx = -1;

    if (typeof ref === 'number' && Number.isFinite(ref)) {
      // Prefer 1-based (t<n>); also accept a 0-based/originIndex hit.
      if (ref >= 1 && ref <= normalized.length) matchIdx = ref - 1;
      else {
        const byOrigin = normalized.findIndex((n) => n.idx === ref);
        if (byOrigin >= 0) matchIdx = byOrigin;
      }
    } else {
      const key = _asText(ref).trim().toLowerCase();
      if (key) {
        // "t<n>" id form.
        const idm = /^t(\d+)$/.exec(key);
        if (idm) {
          const n = Number(idm[1]);
          if (n >= 1 && n <= normalized.length) matchIdx = n - 1;
        }
        if (matchIdx < 0) {
          // Fall back to a title/name/role/prompt-prefix match against other nodes.
          matchIdx = normalized.findIndex((n) => n.idx !== selfIdx && n.keys.has(key));
        }
      }
    }

    if (matchIdx < 0) {
      dangling = true;
      continue;
    }
    if (matchIdx === selfIdx) continue; // drop self-reference
    ids.add(normalized[matchIdx].id);
  }

  return { ids, dangling };
}

/**
 * Compile subtasks (each possibly carrying `dependencies`) into ordered execution
 * waves via Kahn-style topological layering. Within a wave: mutually independent
 * (parallel-safe). Between waves: strict ordering. Pure, deterministic, never throws.
 *
 * Conservative degradations (never stall on a bad edge):
 *   * gate off / empty / no dependency edges at all → ONE all-parallel wave (flat)
 *   * a reference that matches no subtask            → drop that edge, flag dangling
 *   * a dependency cycle                             → collapse to ONE flat wave
 *   * any internal exception                         → ONE flat wave, ok:false
 *
 * @param {Array<object>} subtasks  [{prompt, role, originIndex, dependencies?}]
 * @param {{env?:object}} [opts]
 * @returns {{ok:boolean, waves:Array<Array<object>>, waveCount:number,
 *            reason:string, hadDanglingDeps:boolean}}
 */
function planWaves(subtasks, opts = {}) {
  try {
    const env = opts && typeof opts === 'object' ? opts.env : undefined;
    if (!_gateEnabled(env)) return _flatResult(Array.isArray(subtasks) ? subtasks : [], 'gate-off');
    if (!Array.isArray(subtasks) || subtasks.length === 0) return _flatResult([], 'empty');
    if (subtasks.length === 1) return _flatResult(subtasks, 'flat');

    // Build normalized index: stable id + the set of strings that may reference it.
    const normalized = subtasks.map((st, i) => {
      const s = st && typeof st === 'object' ? st : {};
      const idxRaw = Number.isFinite(s.originIndex) ? s.originIndex : i;
      const keys = new Set();
      for (const k of [s.title, s.name, s.role]) {
        const kv = _asText(k).trim().toLowerCase();
        if (kv) keys.add(kv);
      }
      // First line of the prompt is a useful human-authored handle too.
      const p0 = _asText(s.prompt).split('\n')[0].trim().toLowerCase();
      if (p0) keys.add(p0);
      return { id: `t${i + 1}`, idx: idxRaw, keys, st };
    });

    // Resolve edges. deps[i] = Set of node ids that node i depends on.
    const deps = new Array(subtasks.length);
    let anyEdge = false;
    let hadDanglingDeps = false;
    for (let i = 0; i < subtasks.length; i += 1) {
      const s = subtasks[i] && typeof subtasks[i] === 'object' ? subtasks[i] : {};
      const { ids, dangling } = _normalizeDeps(s.dependencies, i, normalized);
      deps[i] = ids;
      if (ids.size > 0) anyEdge = true;
      if (dangling) hadDanglingDeps = true;
    }

    // No real edges → today's flat behavior (but surface that we saw dangling refs).
    if (!anyEdge) {
      const flat = _flatResult(subtasks, hadDanglingDeps ? 'flat-dangling' : 'flat');
      flat.hadDanglingDeps = hadDanglingDeps;
      return flat;
    }

    // Kahn layering: repeatedly take the nodes whose deps are all already done.
    // `waveGlobalIndex[w]` records each wave member's SOURCE position so the
    // fault-aware executor can key on global indices WITHOUT re-deriving them via
    // indexOf (which would misfire on duplicate-identical subtask objects).
    const remaining = new Set(normalized.map((_, i) => i));
    const doneIds = new Set();
    const waves = [];
    const waveGlobalIndex = [];
    let guard = 0;
    const maxIters = subtasks.length + 1;

    while (remaining.size > 0 && guard <= maxIters) {
      guard += 1;
      const ready = [];
      for (const i of remaining) {
        const need = deps[i];
        let satisfied = true;
        for (const depId of need) {
          if (!doneIds.has(depId)) { satisfied = false; break; }
        }
        if (satisfied) ready.push(i);
      }
      if (ready.length === 0) {
        // No progress with nodes still remaining → a cycle. Collapse conservatively.
        const flat = _flatResult(subtasks, 'cycle-detected');
        flat.hadDanglingDeps = hadDanglingDeps;
        return flat;
      }
      ready.sort((a, b) => a - b); // stable order within a wave
      waves.push(ready.map((i) => subtasks[i]));
      waveGlobalIndex.push(ready.slice());
      for (const i of ready) {
        remaining.delete(i);
        doneIds.add(normalized[i].id);
      }
    }

    if (remaining.size > 0) {
      // Safety net (should be unreachable) — degrade to flat rather than partial.
      const flat = _flatResult(subtasks, 'cycle-detected');
      flat.hadDanglingDeps = hadDanglingDeps;
      return flat;
    }

    // Expose the RESOLVED dependency edges by 0-based GLOBAL index. deps[i] holds
    // "t<n>" ids where n = (source position) + 1, so id "t<n>" → global index n-1.
    // Only resolved edges are present (dangling refs were already dropped), so the
    // fault-stop partition never skips on a dropped/dangling edge.
    const edges = deps.map((idSet) => {
      const out = new Set();
      for (const id of idSet) {
        const m = /^t(\d+)$/.exec(id);
        if (m) out.add(Number(m[1]) - 1);
      }
      return out;
    });

    return {
      ok: true,
      waves,
      waveCount: waves.length,
      reason: waves.length > 1 ? 'layered' : (hadDanglingDeps ? 'flat-dangling' : 'flat'),
      hadDanglingDeps,
      edges,
      waveGlobalIndex,
    };
  } catch {
    // Never throw: worst case, hand back one flat wave so the run still proceeds.
    const safe = Array.isArray(subtasks) ? subtasks.slice() : [];
    return {
      ok: false,
      waves: safe.length ? [safe] : [],
      waveCount: safe.length ? 1 : 0,
      reason: 'error-fallback',
      hadDanglingDeps: false,
      edges: Array.from({ length: safe.length }, () => new Set()),
      waveGlobalIndex: safe.length ? [Array.from({ length: safe.length }, (_, i) => i)] : [],
    };
  }
}

/**
 * Fault-aware wave partition: given a wave's member GLOBAL indices, the resolved
 * dependency `edges` (from planWaves), and the set of global indices that have
 * already FAILED or been SKIPPED upstream, split the wave into the members that
 * are still safe to run and the ones whose foundation has collapsed.
 *
 * A wave member at global index `g` is SKIPPED iff any of its resolved
 * dependencies (`edges[g]`) is in `failedGlobalIdxSet`. This is the honest half of
 * "collect results back": a subtask whose dependency failed must NOT be launched
 * on a broken premise — it is reported as skipped, not silently run.
 *
 * Because only RESOLVED edges live in `edges` (dangling refs were dropped by
 * planWaves), a dangling dependency can never trigger a skip. Pure, never throws:
 * malformed input degrades conservatively to "run everything, skip nothing".
 *
 * @param {number[]} waveGlobalIdx        this wave's member global indices
 * @param {Set<number>[]} edges           per-global-index resolved dependency sets
 * @param {Set<number>} failedGlobalIdxSet global indices already failed/skipped
 * @returns {{toRun:number[], toSkip:number[]}} both are global-index arrays
 */
function partitionWaveBySurvivors(waveGlobalIdx, edges, failedGlobalIdxSet) {
  const toRun = [];
  const toSkip = [];
  if (!Array.isArray(waveGlobalIdx)) return { toRun, toSkip };
  const failed = failedGlobalIdxSet instanceof Set ? failedGlobalIdxSet : new Set();
  const edgeList = Array.isArray(edges) ? edges : [];

  for (const g of waveGlobalIdx) {
    const need = edgeList[g];
    let broken = false;
    if (need && typeof need.forEach === 'function') {
      for (const depIdx of need) {
        if (failed.has(depIdx)) { broken = true; break; }
      }
    }
    if (broken) toSkip.push(g);
    else toRun.push(g);
  }
  return { toRun, toSkip };
}

// ---------------------------------------------------------------------------
// Predecessor-result INJECTION into downstream waves (farewell gift, 第三发).
//
// WHY: waves now run in order (planWaves) and fail honestly (partitionWaveBy-
// Survivors). But a downstream subtask's forked sub-agent still runs BLIND — it
// never sees what its predecessor wave produced. `implement` cannot see what
// `explore` found. That is time-ordering without INFORMATION-ordering. The dead
// code `subAgentOrchestrator.executeDependencyAware` (zero callers) already
// specifies the missing semantics: prepend each direct predecessor's result text
// to the dependent's prompt, truncated at 4000 chars on a newline boundary. This
// leaf mirrors that spec WITHOUT waking the dead code (touching the orchestrator /
// god-file would violate 外科手术式改动 B3).
//
// All four functions below are PURE (zero IO, never throw, deterministic).
// ---------------------------------------------------------------------------

// Mirror subAgentOrchestrator's MAX_DEP truncation budget byte-for-byte.
const _MAX_DEP_TEXT = 4000;

/**
 * Extract the human-readable result text from a per-subtask result object.
 * Mirrors taskDecomposer's `result.text || result.output` read, but WITHOUT its
 * `'(无输出)'` placeholder: an empty/absent text must yield '' so the caller can
 * skip it rather than inject a meaningless "(no output)" line into a downstream
 * prompt. Pure, never throws.
 */
function _extractResultText(resultObj) {
  if (!resultObj || typeof resultObj !== 'object') return '';
  const t = resultObj.text;
  if (typeof t === 'string' && t.length > 0) return t;
  const o = resultObj.output;
  if (typeof o === 'string' && o.length > 0) return o;
  return '';
}

/**
 * Truncate predecessor text to _MAX_DEP_TEXT chars, cutting on the last newline
 * before the limit when there is one. Byte-identical to the dead code's rule:
 * the cut is used only when `cut > 0` (a leading-region newline at index 0 is
 * NOT used), and the reported dropped-char count is `length - _MAX_DEP_TEXT`
 * (the raw overflow, NOT `length - cut`). Pure, never throws.
 */
function _truncateDepText(depText) {
  if (typeof depText !== 'string') return depText == null ? '' : _asText(depText);
  if (depText.length <= _MAX_DEP_TEXT) return depText;
  const cut = depText.lastIndexOf('\n', _MAX_DEP_TEXT);
  const head = depText.slice(0, cut > 0 ? cut : _MAX_DEP_TEXT);
  return `${head}\n... [truncated ${depText.length - _MAX_DEP_TEXT} chars]`;
}

/**
 * Build the predecessor-context block for the wave member at global index
 * `globalIdx`. For each DIRECT resolved dependency `d` (from `edges[globalIdx]`,
 * ascending), look up its prior result in `priorResultsByGlobalIdx`, extract +
 * truncate its text, and emit a `[前驱结果 t<d+1>]: <text>` line. Non-empty
 * lines are joined with '\n'. Returns '' when there are no dependencies, no
 * prior text, or the input is malformed. Only DIRECT deps are injected (a direct
 * parent's output already transitively carries what the grandparent produced,
 * matching the dead code and keeping the 4000-char budget from bloating).
 * Pure, never throws.
 *
 * @param {object} subtask                       the dependent subtask (unused today; kept for parity/extension)
 * @param {Set<number>[]} edges                  per-global-index resolved dep sets (planWaves.edges)
 * @param {number} globalIdx                     this member's global index
 * @param {Map<number,object>} priorResultsByGlobalIdx  globalIdx → inner result object
 * @returns {string}
 */
function buildPredecessorContext(subtask, edges, globalIdx, priorResultsByGlobalIdx) {
  try {
    if (!Array.isArray(edges)) return '';
    const need = edges[globalIdx];
    if (!need || typeof need.forEach !== 'function' || need.size === 0) return '';
    const map = priorResultsByGlobalIdx instanceof Map ? priorResultsByGlobalIdx : new Map();
    const deps = Array.from(need).filter(Number.isInteger).sort((a, b) => a - b);
    const lines = [];
    for (const d of deps) {
      const text = _truncateDepText(_extractResultText(map.get(d)));
      if (text) lines.push(`[前驱结果 t${d + 1}]: ${text}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Prepend a predecessor-context block to a subtask's prompt, separated by a
 * horizontal rule so the sub-agent can tell the injected context from its own
 * task. Empty/non-string block → prompt unchanged (byte-identical to no
 * injection). Pure, never throws.
 */
function injectPredecessorContext(promptText, contextBlock) {
  const p = typeof promptText === 'string' ? promptText : '';
  if (typeof contextBlock !== 'string' || contextBlock.length === 0) return p;
  return `${contextBlock}\n\n---\n\n${p}`;
}

module.exports = {
  planWaves,
  partitionWaveBySurvivors,
  buildPredecessorContext,
  injectPredecessorContext,
  _gateEnabled,
  _normalizeDeps,
  _flatResult,
  _extractResultText,
  _truncateDepText,
};
