/**
 * TOON Codec — Token-Optimized Object Notation (public surface / host).
 *
 * Thin re-export host assembled from two pure leaves so the `account/tokenless`
 * subsystem stays within the 400-line architecture policy:
 *   - ./toonEncode  — JSON → TOON encoding (`encode` + its private helpers)
 *   - ./toonDecode  — TOON → JSON decoding (`decode`, `_parseLines`, depth cap)
 *
 * The two leaves share only the primitive `INDENT` (each keeps its own copy),
 * so there is no host↔leaf back-edge. Rebinding the destructured names into
 * `module.exports` via shorthand keeps every exported symbol bound to the SAME
 * function/const identity as before the split.
 *
 * Cross-platform: pure JavaScript, no dependencies.
 */

'use strict';

const { encode } = require('./toonEncode');
const {
  decode,
  _toonDepthCapEnabled,
  _TOON_MAX_DECODE_DEPTH,
} = require('./toonDecode');

module.exports = {
  encode,
  decode,
  _toonDepthCapEnabled,
  _TOON_MAX_DECODE_DEPTH,
};
