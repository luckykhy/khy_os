'use strict';

// Live-region capacity seal threshold — pure leaf, never throws.
//
// Resolves the KHY_TUI_LIVE_SEAL_KB env gate into a character budget for the
// TUI live-region seal guard (useQueryBridge onChunk text branch): once the
// open streaming text segment grows past this many characters, the guard asks
// flushCompletedStages to seal the completed prefix into scrollback so the
// live region never accumulates without bound during a very long reply.
//
// Contract:
//   - unset / empty       → DEFAULT_KB × 1024 characters (64KB default)
//   - '0'/'off'/'false'/'no' → 0 (guard fully disabled)
//   - positive number N   → N × 1024 characters (fractions allowed, floored)
//   - anything invalid    → default (fail-soft, never throws)
const DEFAULT_KB = 64;

function liveSealThresholdChars(env) {
  try {
    const src = env && typeof env === 'object' ? env : {};
    const raw = String(src.KHY_TUI_LIVE_SEAL_KB == null ? '' : src.KHY_TUI_LIVE_SEAL_KB)
      .trim()
      .toLowerCase();
    if (['0', 'off', 'false', 'no'].includes(raw)) {
      return 0;
    } // explicit opt-out
    if (raw === '') {
      return DEFAULT_KB * 1024;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return DEFAULT_KB * 1024;
    } // invalid → default
    return Math.floor(n * 1024);
  } catch {
    return DEFAULT_KB * 1024;
  }
}

module.exports = { liveSealThresholdChars, DEFAULT_KB };
