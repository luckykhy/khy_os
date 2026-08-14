'use strict';

/**
 * Indicator engine selector.
 *
 * env INDICATOR_ENGINE=fast  → use optimized Float64Array implementation
 * env INDICATOR_ENGINE=wasm  → (future) use MoonBit WASM module
 * default                    → original inline methods on comprehensiveDataService
 *
 * Usage in comprehensiveDataService:
 *   const indicators = require('./indicators');
 *   // Then: indicators.calculateMA(data, period)
 *   // instead of: this.calculateMA(data, period)
 */

const fast = require('./fastIndicators');

const ENGINE = (process.env.INDICATOR_ENGINE || '').toLowerCase();

let engine;

if (ENGINE === 'fast' || ENGINE === 'wasm') {
  engine = fast;
  // Future: if ENGINE === 'wasm', load WASM module here
} else {
  // Fallback: export same functions so callers can use them uniformly
  engine = fast; // default to fast — original is kept as inline methods
}

module.exports = engine;
