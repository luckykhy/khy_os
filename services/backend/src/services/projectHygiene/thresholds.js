'use strict';

/**
 * projectHygiene/thresholds.js — single source of the runtime knobs that bound
 * the two project-creation red lines ([DESIGN-ARCH-054]):
 *   1. god files          (a single source file doing too much / too long)
 *   2. duplicate modules  (a second file re-implementing existing functionality)
 *
 * Every threshold is env-overridable with a safe default — zero hardcoded red
 * lines (AGENTS.md engineering rule). Values are read lazily on each call so a
 * test or a session can flip them via process.env without re-requiring.
 */

function intEnv(name, def) {
  const n = parseInt(String(process.env[name] || ''), 10);
  return Number.isInteger(n) && n > 0 ? n : def;
}

function ratioEnv(name, def) {
  const n = parseFloat(String(process.env[name] || ''));
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : def;
}

/**
 * God-file LOC ceiling. Inherits the repo-wide arch-debt knob
 * (KHY_ARCH_GOD_FILE_LOC, used by scripts/archDebtScan.js R2) so the authoring
 * guard and the CI scan agree on one number, but a project-specific override
 * (KHY_PROJECT_GOD_FILE_LOC) wins when set. Default 2500 matches archDebtScan.
 */
function godFileLoc() {
  return intEnv('KHY_PROJECT_GOD_FILE_LOC', intEnv('KHY_ARCH_GOD_FILE_LOC', 2500));
}

/**
 * Exported-symbol overlap ratio above which a new file is judged a duplicate of
 * an existing one. overlap = |new ∩ existing| / |new symbols|. 0.6 = "most of
 * what this new file declares already lives in that other file".
 */
function dupSymbolOverlap() {
  return ratioEnv('KHY_PROJECT_DUP_SYMBOL_OVERLAP', 0.6);
}

/**
 * Token-shingle Jaccard similarity above which two files are judged
 * near-identical content (copy-paste). Deliberately high (0.82) — content
 * similarity is the strongest signal but also the easiest to false-positive on
 * boilerplate, so we only flag near-clones.
 */
function dupContentJaccard() {
  return ratioEnv('KHY_PROJECT_DUP_CONTENT_JACCARD', 0.82);
}

/**
 * Minimum number of declared symbols a new file must have before the symbol
 * signal is trusted — below this, overlap is noise (e.g. a 1-export shim).
 */
function dupMinSymbols() {
  return intEnv('KHY_PROJECT_DUP_MIN_SYMBOLS', 3);
}

/**
 * Upper bound on how many sibling files the duplicate scan reads per write.
 * Keeps the pre-write guard cheap on large projects (bounded, not exhaustive).
 * When a project exceeds this, only the first N candidates are compared and the
 * caller is told the scan was capped (no silent truncation).
 */
function dupMaxScanFiles() {
  return intEnv('KHY_PROJECT_DUP_MAX_SCAN_FILES', 400);
}

/** Largest file (bytes) the duplicate scan will read into memory per candidate. */
function dupMaxFileBytes() {
  return intEnv('KHY_PROJECT_DUP_MAX_FILE_BYTES', 512 * 1024);
}

/** Master kill-switch. KHY_PROJECT_HYGIENE=off disables all hygiene checks. */
function enabled() {
  return String(process.env.KHY_PROJECT_HYGIENE || '').trim().toLowerCase() !== 'off';
}

module.exports = {
  intEnv,
  ratioEnv,
  godFileLoc,
  dupSymbolOverlap,
  dupContentJaccard,
  dupMinSymbols,
  dupMaxScanFiles,
  dupMaxFileBytes,
  enabled,
};
