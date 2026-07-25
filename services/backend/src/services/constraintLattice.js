'use strict';

/**
 * constraintLattice.js — Phase D of the CB-SSP redesign (§4.D, the Π_C operator).
 *
 * The six built-in tool guards (toolGuards.js) are, mathematically, the hard
 * constraints c of the state s=(h,b,r,c). Until now they were a flat list of
 * imperative `{action:'block'}` returns with an ad-hoc `approvable` flag; whether
 * a block could be lifted by the user lived implicitly in that flag and in a
 * doc-comment contract ("hard guards never set approvable"). This module makes
 * that contract an explicit, testable PARTIAL ORDER — a three-element lattice:
 *
 *        ⊤  TOP      — always feasible (an allow, or a relaxed soft block)
 *        │
 *        SOFT        — feasible only with human authorization (guardApproval
 *        │             is the relaxation operator λ that lifts SOFT → TOP at
 *        │             cost λ_human folded into g)
 *        ⊥  BOTTOM   — a red line: infeasible, and a FIXED POINT of relaxation
 *                      (no approval can lift it — relax(⊥)=⊥)
 *
 * Π_C is the projection that prunes the full action set A_full down to the
 * feasible A(s) using these positions, while GUARANTEEING A(s) ≠ ∅ (liveness):
 * the lattice declares a small floor of always-feasible escape actions
 * (ask_user / abort) that no policy may prune, so the agent is never wedged with
 * an empty action set (the §3.1 liveness gap).
 *
 * Design properties this module is built to satisfy (asserted in the test):
 *   - Partial order: reflexive, antisymmetric, transitive; ⊥ ⊏ SOFT ⊏ ⊤.
 *   - Red-line irreducibility: relax(⊥, approved) = ⊥ for ANY approval.
 *   - Soft relaxation: relax(SOFT, approved=true) = ⊤, else SOFT; idempotent.
 *   - Golden regression: classifying each existing guard result reproduces the
 *     current approvable contract exactly (PathTraversal/RateLimit → ⊥;
 *     EditBoundary/PriorRead/FileStale soft block → SOFT; allow → ⊤).
 *   - Liveness: ensureLiveness(actions) is never empty.
 *
 * Pure + side-effect free. Every tunable is env-overridable with a named-constant
 * default (zero hardcoding). New guards join the lattice by declaring a position
 * here — a single source of truth — not by re-implementing block semantics.
 *
 * ── Convergence with metaplan/constraintStrategy (单一真源收敛) ────────────────
 * The codebase had TWO independent 3-element ordered chains drifting apart:
 * THIS lattice (feasibility domain: ⊥ BOTTOM ⊏ SOFT ⊏ ⊤ TOP, higher = MORE
 * feasible) and `metaplan/constraintStrategy.js` (lock-magnitude domain:
 * Prompt_Soft ⊏ Code_Hard ⊏ System_Block, higher = MORE locked). They are not
 * two truths — they are exact ORDER DUALS of one another: feasibility is the
 * inverse of lock magnitude. `constraintStrategy` is now the CANONICAL constraint
 * ladder (the abstract "how much lock" algebra named by DESIGN-ARCH-025/034);
 * this module is its declared feasibility-dual PROJECTION for the guard/approval
 * domain (it additionally owns the guard-source red-line registry + liveness
 * floor, which have no place in the abstract ladder). The bijection below is the
 * single documented contract binding the two; `constraintLatticeStrategyDuality`
 * test mechanically asserts the duality (rank-complement + meet↔escalate) so the
 * two chains can never silently desync. Map back via `toStrategy/fromStrategy`.
 */

// ── Lattice elements ─────────────────────────────────────────────────────────
const BOTTOM = 'bottom'; // ⊥ red line, infeasible, irreducible
const SOFT = 'soft';     // approvable, feasible only after human authorization
const TOP = 'top';       // ⊤ feasible

// Height in the chain ⊥(0) ⊏ SOFT(1) ⊏ ⊤(2). The order IS this numeric rank.
const RANK = { [BOTTOM]: 0, [SOFT]: 1, [TOP]: 2 };

function isElement(x) {
  return x === BOTTOM || x === SOFT || x === TOP;
}

/** Partial order: a ⊑ b. Reflexive, antisymmetric, transitive by construction. */
function leq(a, b) {
  return RANK[a] <= RANK[b];
}
/** Strict order a ⊏ b. */
function lt(a, b) {
  return RANK[a] < RANK[b];
}
/** Least upper bound (the more-feasible of the two). */
function join(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}
/** Greatest lower bound (the more-constrained of the two). */
function meet(a, b) {
  return RANK[a] <= RANK[b] ? a : b;
}

// ── Declared guard positions (the formal single source of truth) ─────────────
// A guard's DECLARED ceiling in the lattice. The per-result `approvable` flag
// (below) decides a block's operational position, but a source declared BOTTOM
// here can NEVER be lifted, even if some result mistakenly sets approvable — the
// red-line declaration dominates (defense in depth for irreducibility).
//
// Sources mirror toolGuards.js registrations (the `builtin:` prefix is stripped
// before lookup). Loop/dedup guardrails and SSRF/critical-destructive blocks are
// red lines by the design doc even though they live in other modules; their
// canonical source ids are declared here so they classify correctly if routed
// through the lattice.
const DECLARED_POSITIONS = Object.freeze({
  // ⊥ red lines — never approvable, never relaxable.
  pathtraversalguard: BOTTOM,
  ratelimitguard: BOTTOM,
  ssrfguard: BOTTOM,
  toolcallguardrail: BOTTOM, // loop / dedup guardrail
  loopguard: BOTTOM,
  dedupguard: BOTTOM,
  criticaldestructiveguard: BOTTOM,
  // SOFT — approvable, guardApproval may lift to ⊤.
  editboundaryguard: SOFT,
  readboundaryguard: SOFT,
  priorreadguard: SOFT,
  filestaleguard: SOFT,
});

function _normSource(source) {
  if (!source) return '';
  return String(source).trim().replace(/^builtin:/i, '').trim().toLowerCase();
}

// Operator-tightenable red-line set: KHY_LATTICE_REDLINE_SOURCES may only ADD
// red lines (a strict tightening of feasibility — always safe). It can never
// downgrade a declared red line to soft.
function _envRedlineSources() {
  const raw = String(process.env.KHY_LATTICE_REDLINE_SOURCES || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => _normSource(s)).filter(Boolean);
}

/**
 * The declared lattice ceiling for a guard source, or null if undeclared.
 * @param {string} source - guard source id (with or without `builtin:` prefix).
 * @returns {('bottom'|'soft'|'top'|null)}
 */
function positionOfSource(source) {
  const key = _normSource(source);
  if (!key) return null;
  if (_envRedlineSources().includes(key)) return BOTTOM;
  return Object.prototype.hasOwnProperty.call(DECLARED_POSITIONS, key)
    ? DECLARED_POSITIONS[key]
    : null;
}

/** True iff the source is a declared (or env-added) red line. */
function isRedLineSource(source) {
  return positionOfSource(source) === BOTTOM;
}

/**
 * Operational lattice position of a guard RESULT — the runtime classifier that
 * reproduces the existing hard/soft/allow contract:
 *   - an allow (or a non-block) → ⊤ (feasible);
 *   - a block with approvable===true → SOFT, UNLESS its source is a declared
 *     red line, in which case ⊥ dominates (a mis-set approvable cannot lift a
 *     red line);
 *   - any other block → ⊥.
 * @param {object} guardResult - { action, approvable?, source? }
 * @returns {('bottom'|'soft'|'top')}
 */
function position(guardResult) {
  const gr = guardResult && typeof guardResult === 'object' ? guardResult : {};
  if (gr.action !== 'block') return TOP; // allow / undefined action = feasible
  // A declared red-line source is BOTTOM regardless of the approvable flag.
  if (positionOfSource(gr.source) === BOTTOM) return BOTTOM;
  return gr.approvable === true ? SOFT : BOTTOM;
}

function isRedLine(guardResult) {
  return position(guardResult) === BOTTOM;
}
function isApprovable(guardResult) {
  return position(guardResult) === SOFT;
}

/**
 * The relaxation operator λ (what guardApproval performs). It can only ever move
 * UP the chain, and only for SOFT:
 *   relax(⊥, *)            = ⊥   (red-line fixed point — irreducible)
 *   relax(SOFT, approved)  = approved ? ⊤ : SOFT
 *   relax(⊤, *)            = ⊤
 * Monotone (output ⊒ input) and idempotent (relax∘relax = relax).
 * @param {string} element - a lattice element.
 * @param {object} [opts]
 * @param {boolean} [opts.approved=false] - whether the user authorized the lift.
 * @returns {string} the resulting lattice element.
 */
function relax(element, { approved = false } = {}) {
  if (!isElement(element)) return BOTTOM; // unknown ⇒ most-constrained (fail-closed)
  if (element === SOFT && approved === true) return TOP;
  return element; // ⊥ and ⊤ are fixed points; SOFT without approval stays SOFT
}

/** Only SOFT elements can be relaxed; ⊥ and ⊤ cannot move. */
function canRelax(element) {
  return element === SOFT;
}

// ── Bijection to the canonical constraint ladder (constraintStrategy) ──────────
// Feasibility ⟷ lock-magnitude order dual. The strategy ENUM STRINGS come from
// constraintStrategy (single source — we never hardcode 'Prompt_Soft' here); only
// the structural pairing lives here. Lazy require + memo so the security-path
// classification above keeps ZERO load-time dependency (fail-closed robustness):
// if constraintStrategy is unavailable, the duality helpers degrade, but position/
// relax/red-line classification are untouched.
//
//   ⊤  TOP    ⟷ Prompt_Soft   (most feasible  ⟷ least locked)
//   SOFT      ⟷ Code_Hard     (approvable middle, both sides)
//   ⊥  BOTTOM ⟷ System_Block  (red line / infeasible ⟷ most locked)
let _strategyMaps = null;
function _maps() {
  if (_strategyMaps) return _strategyMaps;
  const S = require('./metaplan/constraintStrategy').STRATEGIES;
  const elementToStrategy = { [TOP]: S.PROMPT_SOFT, [SOFT]: S.CODE_HARD, [BOTTOM]: S.SYSTEM_BLOCK };
  const strategyToElement = { [S.PROMPT_SOFT]: TOP, [S.CODE_HARD]: SOFT, [S.SYSTEM_BLOCK]: BOTTOM };
  _strategyMaps = { elementToStrategy, strategyToElement };
  return _strategyMaps;
}

/**
 * Project a feasibility element onto the canonical constraint ladder.
 * @param {string} element - BOTTOM | SOFT | TOP.
 * @returns {string|null} the dual constraintStrategy value, or null if unknown.
 */
function toStrategy(element) {
  try { return _maps().elementToStrategy[element] || null; }
  catch { return null; }
}

/**
 * Lift a canonical constraint strategy back to its feasibility element (inverse
 * of toStrategy). Unknown / unavailable → BOTTOM (fail-closed, most-constrained).
 * @param {string} strategy - Prompt_Soft | Code_Hard | System_Block.
 * @returns {string} a lattice element.
 */
function fromStrategy(strategy) {
  try {
    const el = _maps().strategyToElement[strategy];
    return el || BOTTOM;
  } catch { return BOTTOM; }
}

// ── Liveness floor — the ⊤ escape actions Π_C must never prune ────────────────
// A(s) must never be empty: even when every domain action is pruned, the agent
// can still ask the user or abort. These are always feasible by construction.
const DEFAULT_LIVENESS_FLOOR = Object.freeze(['ask_user', 'askuserquestion', 'abort']);

function _livenessFloor() {
  const extra = String(process.env.KHY_LIVENESS_FALLBACK || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // De-duplicate while preserving the defaults first.
  const set = new Set([...DEFAULT_LIVENESS_FLOOR, ...extra]);
  return Array.from(set);
}

/** True iff `toolName` is a guaranteed-feasible escape action (the ⊤ floor). */
function isLivenessFloor(toolName) {
  if (!toolName) return false;
  return _livenessFloor().includes(String(toolName).trim().toLowerCase());
}

/**
 * Π_C liveness guarantee. Given the candidate feasible actions after pruning,
 * return a NON-EMPTY action set: if pruning emptied it, fall back to the escape
 * floor. A non-empty input is returned unchanged (zero behavior change in the
 * common case).
 * @param {string[]} actions - candidate action names after constraint pruning.
 * @returns {string[]} a guaranteed non-empty action set.
 */
function ensureLiveness(actions) {
  const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
  if (list.length > 0) return list.slice();
  return _livenessFloor();
}

/**
 * Policy-layer glue: never let an allowlist/blocklist prune an escape action.
 * Given a block reason a per-tool policy produced, suppress it (return null) when
 * the tool is a liveness-floor action — guaranteeing the escape hatch survives
 * any policy, so A(s) ≠ ∅. Any other block reason passes through unchanged.
 * @param {string} toolName
 * @param {string|null} blockReason
 * @returns {string|null}
 */
function feasibleUnderPolicy(toolName, blockReason) {
  if (blockReason && isLivenessFloor(toolName)) return null;
  return blockReason || null;
}

module.exports = {
  // elements + order
  BOTTOM,
  SOFT,
  TOP,
  RANK,
  isElement,
  leq,
  lt,
  join,
  meet,
  // classification
  positionOfSource,
  isRedLineSource,
  position,
  isRedLine,
  isApprovable,
  // relaxation operator
  relax,
  canRelax,
  // canonical-ladder bijection (constraintStrategy is the single source)
  toStrategy,
  fromStrategy,
  // liveness
  DEFAULT_LIVENESS_FLOOR,
  isLivenessFloor,
  ensureLiveness,
  feasibleUnderPolicy,
};
