// Auto-generated shim - re-exports from new domain location
// Do not edit - move services/backend/src/services/domain/extensions/extensions instead
//
// Restored 2026-09-06: 20 route shims (src/routes/strategy.js et al.) require
// '../services/extensions/quantApp' directly; with this file missing the whole
// backend failed to boot (MODULE_NOT_FOUND at require time of routes/strategy.js).
module.exports = require('../domain/extensions/extensions/quantApp.js');
