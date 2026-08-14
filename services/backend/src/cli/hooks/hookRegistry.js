'use strict';

/**
 * hookRegistry.js — back-compat shim.
 *
 * The hooks subsystem (hookRegistry/hookRunner/hookSystem) moved down to the
 * services layer (services/hooks/) so that services (toolUseLoop,
 * contextCompressor) no longer reach UP into the cli layer for it
 * (R1-layering inversion). This re-export keeps cli-layer and coordinator
 * importers working at their original path — a cli module requiring a service
 * is a normal downward dependency.
 */

module.exports = require('../../services/hooks/hookRegistry');
