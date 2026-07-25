'use strict';

/**
 * streamRepetitionGuard.js — live token-repetition (degeneration) guard.
 *
 * Problem this exists to solve: weak / low-tier models can fall into
 * "repetition degeneration" — once they emit a short fragment (e.g. `要,`),
 * the most-probable next token is that same fragment again, so they emit it
 * thousands of times and never escape. On the streaming path this floods the
 * user with `要,要,要,要…` (see the "讲个笑话" runaway).
 *
 * Design goal (per product directive): detect EARLY and CORRECT, do not just
 * kill the connection. This module is a pure-leaf detector — it only *finds*
 * the degenerate tail and reports where the clean prefix ends. The caller
 * (toolUseLoop) decides what to do: stop forwarding the flood, discard the
 * draft, and re-prompt the model to finish cleanly (graceful correction), with
 * a salvaged-prefix fallback so the user is never left with a bare error.
 *
 * No I/O, no model calls, no dependencies — trivially unit-testable.
 */

// ── Defaults (all env-overridable at the call site; these are the floor) ────

const DEFAULTS = {
  // Smallest repeating unit to consider. 1 catches a single chanted character.
  minUnit: 1,
  // Largest repeating unit. Big enough to catch a chanted short phrase
  // ("要袋子吗要袋子吗…", "哈哈哈哈…") but small enough that a legitimately
  // repeated paragraph (rare in prose) does not trip.
  maxUnit: 48,
  // Minimum consecutive repeats of the unit before the tail is "degenerate".
  // 12 is well clear of legitimate emphasis ("哈哈哈哈" is only ~4).
  minRepeats: 12,
  // Minimum total characters spanned by the repeated run. Guards against tiny
  // units tripping on short bursts (12×"!" = 12 chars is allowed; only a long
  // run is degeneration).
  minRunChars: 48,
  // Bounded tail buffer for the stateful streaming guard. Degeneration always
  // manifests at the tail, so we never need the whole reply in memory.
  maxBuffer: 4096,
};

function _envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Whether the live guard is enabled (default on; KHY_STREAM_REPETITION_GUARD=0 disables). */
function isEnabled() {
  const raw = process.env.KHY_STREAM_REPETITION_GUARD;
  if (raw == null || raw === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

/** Resolve the active config, layering env overrides over the defaults. */
function resolveConfig(overrides = {}) {
  return {
    minUnit: DEFAULTS.minUnit,
    maxUnit: _envInt('KHY_STREAM_REPETITION_MAX_UNIT', DEFAULTS.maxUnit),
    minRepeats: _envInt('KHY_STREAM_REPETITION_MIN_REPEATS', DEFAULTS.minRepeats),
    minRunChars: _envInt('KHY_STREAM_REPETITION_MIN_RUN_CHARS', DEFAULTS.minRunChars),
    maxBuffer: _envInt('KHY_STREAM_REPETITION_MAX_BUFFER', DEFAULTS.maxBuffer),
    ...overrides,
  };
}

/**
 * Pure detector. Scan the TAIL of `text` for a short unit repeated
 * consecutively. Returns the smallest qualifying unit (so `要,要,要…` is
 * reported as unit `要,`, not a longer multiple of it).
 *
 * @param {string} text
 * @param {object} [opts] - { minUnit, maxUnit, minRepeats, minRunChars }
 * @returns {{ tripped: boolean, unit?: string, unitLength?: number,
 *            repeats?: number, runChars?: number, runStart?: number,
 *            cleanPrefixLength?: number }}
 *   On a trip, `cleanPrefixLength` is the length of the clean prefix to keep —
 *   it retains exactly ONE instance of the repeated unit (so the salvaged text
 *   reads naturally) and drops the rest of the run.
 */
function findRepetition(text, opts = {}) {
  const cfg = { ...resolveConfig(), ...opts };
  const s = typeof text === 'string' ? text : '';
  const len = s.length;
  if (len < cfg.minRunChars) return { tripped: false };

  const maxUnit = Math.min(cfg.maxUnit, Math.floor(len / 2));

  for (let L = cfg.minUnit; L <= maxUnit; L++) {
    const unit = s.slice(len - L);
    // Count consecutive repeats of `unit` walking backwards from the tail.
    let repeats = 1;
    let pos = len - L;
    while (pos - L >= 0 && s.slice(pos - L, pos) === unit) {
      repeats++;
      pos -= L;
    }
    const runChars = repeats * L;
    if (repeats >= cfg.minRepeats && runChars >= cfg.minRunChars) {
      const runStart = len - runChars;
      // Keep one unit of the run so the salvaged prefix reads naturally.
      return {
        tripped: true,
        unit,
        unitLength: L,
        repeats,
        runChars,
        runStart,
        cleanPrefixLength: runStart + L,
      };
    }
  }
  return { tripped: false };
}

/**
 * A short, stable signature of a detected repetition, used by the caller to
 * notice "the model degenerated the SAME way again after a correction nudge"
 * and stop re-prompting (mirrors the refusal-repeat break).
 */
function repetitionSignature(result) {
  if (!result || !result.tripped) return null;
  return `rep:${result.unitLength}:${String(result.unit || '').slice(0, 16)}`;
}

/**
 * Stateful streaming guard. Feed it text chunks as they arrive; ask `inspect()`
 * whether the live stream has degenerated. Keeps only a bounded tail buffer.
 *
 * @param {object} [opts] - config overrides (see resolveConfig)
 */
function create(opts = {}) {
  const cfg = resolveConfig(opts);
  let buf = '';
  let tripped = null; // cached trip result once detected

  return {
    config: cfg,
    /** Append a streamed text fragment. */
    push(text) {
      if (typeof text !== 'string' || text.length === 0) return;
      buf += text;
      if (buf.length > cfg.maxBuffer) buf = buf.slice(buf.length - cfg.maxBuffer);
    },
    /**
     * @returns {{ tripped: boolean, ... }} the (cached) detector result over the
     *   accumulated tail buffer. Once tripped, stays tripped.
     */
    inspect() {
      if (tripped) return tripped;
      const r = findRepetition(buf, cfg);
      if (r.tripped) tripped = r;
      return r;
    },
    /** True once a degeneration has been detected this round. */
    get tripped() {
      return !!tripped;
    },
    reset() {
      buf = '';
      tripped = null;
    },
  };
}

module.exports = {
  isEnabled,
  resolveConfig,
  findRepetition,
  repetitionSignature,
  create,
  DEFAULTS,
};
