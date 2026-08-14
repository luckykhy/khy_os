'use strict';

/**
 * formatBytes.js — canonical truth source for "byte count → human-readable
 * size string" formatting across the backend.
 *
 * Converges 4 previously independent implementations (each kept as a thin
 * delegate with its original name/signature, call sites untouched):
 *   - services/cleanupService.humanSize            → formatBytes(b)                          (B/KB/MB, 3-tier)
 *   - services/workspace/checkpointService._formatSize → formatBytes(b, { maxUnit: 'GB' })   (B/KB/MB/GB, 4-tier)
 *   - cli/handlers/workspace._formatSize (legacy fallback branch only)
 *                                                  → formatBytes(b)                          (B/KB/MB, 3-tier)
 *   - services/deviceApps/deviceAppsDownloader.formatBytes
 *                                                  → formatBytes(n, { maxUnit: 'TB', sanitize: true })
 *
 * Byte-for-byte equivalence proof sketch:
 *   - The original 3/4-tier chains are `if (b < 1024^k) …` cascades; this atom
 *     mirrors them with a `!(v < divisor * 1024)` advance loop so that NaN and
 *     non-numeric inputs fall through to the LAST unit exactly like the
 *     original cascades did (NaN comparisons are all false → "NaN MB"/"NaN GB").
 *   - The downloader's cascaded `x /= 1024` loop divides by exact powers of two,
 *     which is lossless in IEEE-754 (exponent-only scaling), so `v/1024/1024…`
 *     is bit-identical to a single `v / 1024^k` division. Its input
 *     sanitisation (non-finite or <= 0 → 0) is reproduced via `sanitize`.
 *   - Sub-1024 values render via template literal `${v} B` (no rounding),
 *     identical to every original (negatives: "-5 B"; strings pass through).
 *
 * Contract: pure, deterministic, never throws, does not mutate inputs.
 *
 * @param {number} bytes - Byte count (may be negative/NaN/non-number; see notes).
 * @param {object} [opts]
 * @param {'KB'|'MB'|'GB'|'TB'} [opts.maxUnit='MB'] - Largest unit the cascade may reach.
 * @param {boolean} [opts.sanitize=false] - Coerce non-finite or <= 0 input to 0 first.
 * @returns {string} e.g. "512 B", "2.0 KB", "3072.0 MB".
 */
function formatBytes(bytes, opts = {}) {
  const UNITS = ['KB', 'MB', 'GB', 'TB'];
  let maxIdx = UNITS.indexOf(opts.maxUnit || 'MB');
  if (maxIdx === -1) {
    maxIdx = 1;
  } // unknown maxUnit → MB (defensive, unused by delegates)

  let v = bytes;
  if (opts.sanitize === true) {
    v = Number.isFinite(v) && v > 0 ? v : 0;
  }

  if (v < 1024) {
    return `${v} B`;
  }

  // Advance while NOT below the next threshold — mirrors the original
  // `if (v < 1024^k)` cascades so NaN falls through to the last unit.
  let divisor = 1024;
  let i = 0;
  while (i < maxIdx && !(v < divisor * 1024)) {
    divisor *= 1024;
    i++;
  }
  return `${(v / divisor).toFixed(1)} ${UNITS[i]}`;
}

module.exports = formatBytes;
