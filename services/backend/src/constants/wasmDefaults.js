'use strict';

/**
 * WASM Runtime constants — single source of truth.
 *
 * All modules that reference WASM ABIs or default settings should
 * import from here instead of maintaining inline literals.
 */

/** Supported WASM ABI versions in dispatch order. */
const SUPPORTED_ABIS = Object.freeze(['numeric-v1', 'string-v2', 'json-v2']);

/** Default ABI when none is specified in an app manifest. */
const DEFAULT_ABI = 'numeric-v1';

module.exports = { SUPPORTED_ABIS, DEFAULT_ABI };
