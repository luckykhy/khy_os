'use strict';

/**
 * effectiveCols — LEGACY ALIAS re-exporting the effectiveDims single source.
 *
 * DESIGN-ARCH-103 P0-1: dimension truth moved to ../effectiveDims (sticky cols
 * AND rows, band-quantized width, the H8 rule that components never read
 * stdout). This file remains so existing `require('../effectiveCols')` call
 * sites keep working byte-identically; new code should require effectiveDims.
 */

const m = require('./effectiveDims');

/**
 * @param {number} [fallback=80]
 * @returns {number}
 */
function effectiveCols(fallback = 80) {
  return m.contentWidth(null, process.env, fallback);
}

module.exports = {
  effectiveCols,
  stickyCols: m.stickyCols,
  _resetStickyColsForTest: m._resetStickyColsForTest,
};
