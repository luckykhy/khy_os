'use strict';

// Spinner verb "shimmer" — pure leaf (zero IO, deterministic, fail-soft).
// Aligns the LOGIC BEHIND Claude Code's working-spinner verb animation, not
// just its look.
//
// CC reference: src/bridge/bridgeStatusUtil.ts —
//   SHIMMER_INTERVAL_MS = 150
//   computeGlimmerIndex(tick, messageWidth):
//     cycleLength = messageWidth + 20
//     return messageWidth + 10 - (tick % cycleLength)
//   computeShimmerSegments(text, glimmerIndex): split `text` into
//     { before, shimmer, after } by VISUAL COLUMN using a 3-column window
//     [glimmerIndex-1 .. glimmerIndex+1]; offscreen → all text as `before`.
// Consumer: CC src/components/Spinner.tsx renders <Text dimColor>{before}</Text>
//   <Text>{shimmer}</Text> <Text dimColor>{after}</Text> — i.e. the verb is
//   dimmed except a normal-brightness 3-column spot that sweeps right→left over
//   `messageWidth + 20` ticks, producing a subtle shimmer that reads as "working".
//
// The backend LOGIC (not the look): a deterministic reverse-sweep index derived
// from a monotonic tick, plus a width-aware (CJK-safe) segmentation of the verb
// by visual column. khy's spinner (cli/spinner.js) renders the verb as flat
// text with no sweep — this leaf supplies the segments; the shell (spinner.js)
// applies its own chalk dim/normal coloring, exactly as CC's two renderers do.
//
// Honest divergence from CC: CC segments by GRAPHEME (Intl grapheme segmenter,
// handling ZWJ/emoji/combining clusters). This leaf segments by CODE POINT
// (Array.from) to stay zero-dependency and fully deterministic — sufficient for
// spinner verbs, which are plain CJK/ASCII words; a combining-mark verb would at
// worst split a cluster (cosmetic only, never throws). Width is injected by the
// caller (khy's displayWidth) so the leaf itself pulls in no width table.

const SHIMMER_INTERVAL_MS = 150;
const OFF_VALUES = ['0', 'false', 'off', 'no'];

function spinnerShimmerEnabled(env) {
  const raw = env && env.KHY_SPINNER_SHIMMER;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// Faithful port of CC computeGlimmerIndex. For a valid (non-negative, integer)
// tick this is byte-identical to CC's `messageWidth + 10 - (tick % cycleLength)`
// (the extra positive-modulo guard only matters for defensive/negative input,
// which CC never feeds since its tick = floor(elapsed/150) ≥ 0).
function computeGlimmerIndex(tick, messageWidth) {
  const t = Number(tick);
  const w = Number(messageWidth);
  if (!Number.isFinite(t) || !Number.isFinite(w)) return -100; // offscreen → no shimmer
  const cycleLength = w + 20;
  if (cycleLength <= 0) return -100;
  const mod = ((Math.trunc(t) % cycleLength) + cycleLength) % cycleLength;
  return w + 10 - mod;
}

// Faithful port of CC computeShimmerSegments (code-point granularity — see
// header). `widthOf` is the injected visual-width function (e.g. displayWidth);
// falls back to string length if absent.
function computeShimmerSegments(text, glimmerIndex, widthOf) {
  const s = String(text == null ? '' : text);
  const w = typeof widthOf === 'function' ? widthOf : (x) => String(x).length;
  const messageWidth = w(s);
  const gi = Number(glimmerIndex);
  const shimmerStart = gi - 1;
  const shimmerEnd = gi + 1;
  // Offscreen (or non-finite index) → whole text is `before`, no shimmer.
  if (!Number.isFinite(gi) || shimmerStart >= messageWidth || shimmerEnd < 0) {
    return { before: s, shimmer: '', after: '' };
  }
  const clampedStart = Math.max(0, shimmerStart);
  let colPos = 0;
  let before = '';
  let shimmer = '';
  let after = '';
  for (const seg of Array.from(s)) {
    const segWidth = w(seg);
    if (colPos + segWidth <= clampedStart) before += seg;
    else if (colPos > shimmerEnd) after += seg;
    else shimmer += seg;
    colPos += segWidth;
  }
  return { before, shimmer, after };
}

/**
 * Convenience for the spinner call-site: given the verb, a monotonic tick, the
 * width function and env, return { before, shimmer, after }. Gate off / bad
 * input / any error → whole verb as `before` (so the shell colors it flat).
 * The returned segments always reassemble to the original verb, so the caller
 * can verify integrity before split-coloring.
 * @param {string} verb
 * @param {number} tick     monotonic tick (caller: floor(elapsedMs / SHIMMER_INTERVAL_MS)).
 * @param {function} widthOf visual-width function (displayWidth).
 * @param {object} [env]
 * @returns {{before:string, shimmer:string, after:string}}
 */
function shimmerSegmentsForTick(verb, tick, widthOf, env) {
  const s = String(verb == null ? '' : verb);
  try {
    if (!spinnerShimmerEnabled(env || (typeof process !== 'undefined' ? process.env : {}))) {
      return { before: s, shimmer: '', after: '' };
    }
    const w = typeof widthOf === 'function' ? widthOf : (x) => String(x).length;
    const idx = computeGlimmerIndex(tick, w(s));
    return computeShimmerSegments(s, idx, w);
  } catch {
    return { before: s, shimmer: '', after: '' };
  }
}

module.exports = {
  SHIMMER_INTERVAL_MS,
  spinnerShimmerEnabled,
  computeGlimmerIndex,
  computeShimmerSegments,
  shimmerSegmentsForTick,
};
