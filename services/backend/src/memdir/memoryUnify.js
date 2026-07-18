'use strict';

// Memory-home unification — pure leaf (zero IO, zero business require,
// deterministic, env-gated). Mirrors the gate idiom of cli/contextWarning.js.
//
// WHY THIS EXISTS (the real defect it fixes):
//   The memory subsystem has a split brain. The RECALL side resolves the
//   memory dir via memdir/paths.js::getMemoryDir() → utils/dataHome.js::
//   getProjectDataHome()/memory. On a pip install that lands INSIDE the
//   package (`<site-packages>/khy_os/bundled/.khy/memory`) — neither durable
//   across upgrades nor where the user looks. The DREAM/consolidation side
//   (assistant/autoDream.js, consolidationLock.js, assistant/index.js) writes
//   getDataDir('memory') = getDataHome()/memory (`~/.khy/memory`). The two
//   homes are separate resolvers with different defaults, so what gets written
//   is never recalled — the assistant "forgets" facts the user just told it,
//   regardless of whether a pip upgrade happened.
//
//   Fix direction (user-confirmed): make the recall side ALSO resolve to
//   getDataHome()/memory — the durable user-home that survives pip upgrades
//   and is exactly where dreaming already writes. This leaf provides the gate
//   decisions; memdir/paths.js (the thin shell) does the IO.
//
// Gates (both default ON, byte-identical OFF fallback):
//   KHY_MEMORY_UNIFIED_HOME  — recall resolves to getDataHome()/memory.
//   KHY_MEMORY_MERGE_LEGACY  — one-time additive copy of orphaned legacy
//                              memory files into the canonical dir.

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _isOff(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return OFF_VALUES.includes(v);
}

/**
 * Gate KHY_MEMORY_UNIFIED_HOME (default ON). When on, getMemoryDir() resolves
 * to the durable getDataHome()/memory instead of getProjectDataHome()/memory.
 * @param {object} env
 * @returns {boolean}
 */
function unifiedHomeEnabled(env) {
  return !_isOff(env && env.KHY_MEMORY_UNIFIED_HOME);
}

/**
 * Gate KHY_MEMORY_MERGE_LEGACY (default ON). When on, a one-time additive copy
 * brings orphaned legacy memory files into the canonical dir (source untouched).
 * @param {object} env
 * @returns {boolean}
 */
function legacyMergeEnabled(env) {
  return !_isOff(env && env.KHY_MEMORY_MERGE_LEGACY);
}

/**
 * Decide which legacy memory files to additively copy into the canonical dir.
 *
 * Pure decision (no IO): returns the `.md` filenames that exist in `legacy` but
 * NOT in `canonical`. ESTABLISHED-WINS — an already-present canonical file is
 * never overwritten. MEMORY.md is intentionally excluded from the copy list:
 * it is the index, reconciled by the downstream updateMemoryIndex union rather
 * than blindly overwritten (overwriting would drop one side's index lines).
 *
 * @param {string[]} canonicalNames - filenames already in the canonical dir
 * @param {string[]} legacyNames    - filenames in the legacy dir
 * @returns {string[]} filenames to copy (legacy-only `.md`, excluding MEMORY.md)
 */
function planLegacyMerge(canonicalNames, legacyNames) {
  const canon = new Set(Array.isArray(canonicalNames) ? canonicalNames : []);
  const legacy = Array.isArray(legacyNames) ? legacyNames : [];
  const out = [];
  for (const raw of legacy) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name) continue;
    if (!/\.md$/i.test(name)) continue;       // only markdown memory files
    if (name === 'MEMORY.md') continue;        // index reconciled separately
    if (canon.has(name)) continue;             // established-wins: never overwrite
    out.push(name);
  }
  return out;
}

module.exports = {
  unifiedHomeEnabled,
  legacyMergeEnabled,
  planLegacyMerge,
};
