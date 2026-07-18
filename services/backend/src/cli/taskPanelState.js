'use strict';

/**
 * taskPanelState.js — back-compat shim.
 *
 * The shared task-progress-panel singleton moved down to the services layer
 * (services/taskPanelState.js) so that planModeService (a service) no longer
 * has to reach UP into the cli layer for it (R1-layering inversion). This
 * re-export keeps the cli-layer importers (repl.js, panels.js) working at
 * their original path; a cli module requiring a service is a normal downward
 * dependency.
 */

module.exports = require('../services/taskPanelState');
