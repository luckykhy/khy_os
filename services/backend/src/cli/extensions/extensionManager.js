'use strict';

/**
 * extensionManager.js — back-compat shim.
 *
 * The extension manager moved down to the services layer
 * (services/extensions/extensionManager.js) so that extensionMarketplace (a
 * service) no longer reaches UP into the cli layer for it (R1-layering
 * inversion). It has no cli-layer dependencies. This re-export preserves the
 * original import path for any dynamic/legacy reference.
 */

module.exports = require('../../services/extensions/extensionManager');
