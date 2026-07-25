'use strict';

/**
 * memoryLifecycle.js — Memory lifecycle state machine + retention weighting.
 *
 * A single source of truth for:
 *   1. The lifecycle stages a memory passes through during consolidation.
 *   2. The legal transitions between stages (forward decay + backward revival).
 *   3. Per-type retention weights used when scoring/ranking memories.
 *
 * "Lossless" principle: `pruned` is NOT physical deletion. A pruned memory is
 * moved to the archive store and can always be revived back to `active` on
 * recall — every stage has a path back to `active`.
 *
 * Stages (forward decay order):
 *   active     → currently relevant, surfaced in working context
 *   recent     → still warm, eligible for light dedup
 *   archived   → cold, retained but not surfaced by default
 *   dream      → selected for deep/REM consolidation
 *   compressed → folded into a synthesized memory (source kept in archive)
 *   pruned     → removed from the active set, persisted in archive (revivable)
 */

// ── Stages ─────────────────────────────────────────────────────────

const LIFECYCLE = Object.freeze({
  ACTIVE: 'active',
  RECENT: 'recent',
  ARCHIVED: 'archived',
  DREAM: 'dream',
  COMPRESSED: 'compressed',
  PRUNED: 'pruned',
});

/** Forward decay order — index reflects "coldness". */
const STAGE_ORDER = Object.freeze([
  LIFECYCLE.ACTIVE,
  LIFECYCLE.RECENT,
  LIFECYCLE.ARCHIVED,
  LIFECYCLE.DREAM,
  LIFECYCLE.COMPRESSED,
  LIFECYCLE.PRUNED,
]);

/**
 * Legal transitions. Every stage retains a path back to `active` so recall can
 * always revive a memory (lossless guarantee).
 */
const TRANSITIONS = Object.freeze({
  active: ['recent', 'archived', 'dream', 'compressed', 'pruned'],
  recent: ['active', 'archived', 'dream', 'compressed', 'pruned'],
  archived: ['active', 'dream', 'compressed', 'pruned'],
  dream: ['active', 'compressed', 'pruned'],
  compressed: ['active', 'pruned'],
  pruned: ['active'],
});

// ── Type retention weights ─────────────────────────────────────────

/**
 * Retention weight by memory type [0,1]. Higher = more important, decays
 * slower, ranked higher for consolidation, resists pruning.
 */
const TYPE_WEIGHTS = Object.freeze({
  milestone: 0.9,
  decision: 0.8,
  commitment: 0.7,
  lesson: 0.7,
  preference: 0.6,
  fact: 0.5,
});

const DEFAULT_TYPE_WEIGHT = 0.5;

// ── API ────────────────────────────────────────────────────────────

/**
 * @param {string} stage
 * @returns {boolean}
 */
function isLifecycleStage(stage) {
  return STAGE_ORDER.includes(stage);
}

/**
 * Whether a transition from `from` to `to` is legal.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(from, to) {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Retention weight for a memory type. Unknown types get the default.
 * @param {string} type
 * @returns {number} weight in [0,1]
 */
function typeWeight(type) {
  if (type && Object.prototype.hasOwnProperty.call(TYPE_WEIGHTS, type)) {
    return TYPE_WEIGHTS[type];
  }
  return DEFAULT_TYPE_WEIGHT;
}

/**
 * Derive the default lifecycle stage from a memory's age. Used to initialize
 * `lifecycle` on legacy entries that predate the field. Stages beyond
 * `archived` are only reached via explicit consolidation transitions, never
 * by age alone.
 *
 * @param {number} ageDays
 * @returns {string} one of active|recent|archived
 */
function stageFromAge(ageDays) {
  if (!(ageDays >= 0)) return LIFECYCLE.ACTIVE;
  if (ageDays < 2) return LIFECYCLE.ACTIVE;
  if (ageDays < 14) return LIFECYCLE.RECENT;
  return LIFECYCLE.ARCHIVED;
}

/**
 * Whether a stage means the memory is no longer in the active working set
 * (but still retained losslessly in the archive store).
 * @param {string} stage
 * @returns {boolean}
 */
function isRetired(stage) {
  return stage === LIFECYCLE.PRUNED || stage === LIFECYCLE.COMPRESSED;
}

module.exports = {
  LIFECYCLE,
  STAGE_ORDER,
  TRANSITIONS,
  TYPE_WEIGHTS,
  DEFAULT_TYPE_WEIGHT,
  isLifecycleStage,
  canTransition,
  typeWeight,
  stageFromAge,
  isRetired,
};
