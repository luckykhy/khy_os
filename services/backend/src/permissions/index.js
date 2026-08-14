/**
 * Permission System — bashSecurity / rules aggregator.
 *
 * Single source of truth for permission gating is `services/permissionStore.js`
 * with profiles `strict / normal / acceptEdits / yolo`, driven by the Shift+Tab
 * cycle in both the TUI (`cli/tui/ink-components/App.js`) and the classic REPL
 * (`cli/repl.js`).
 *
 * This module exists only to re-export `bashSecurity` and `rules` for
 * convenience. The former `mode` layer (getPermissionMode / setPermissionMode /
 * cyclePermissionMode / checkPermission / getModeDescription) was RETIRED and
 * has been removed — it had no callers and encoded a Claude-Code-INVERTED
 * mapping where `bypass` meant the STRICT "confirm everything" mode. Claude
 * Code (and permissionStore's `yolo`) use bypass to mean "allow everything";
 * do NOT reintroduce the inverted mode functions here. Use permissionStore.
 */
'use strict';

const bashSecurity = require('./bashSecurity');
const rules = require('./rules');

module.exports = {
  // Re-exports for convenience. Permission *gating* lives in permissionStore.
  bashSecurity,
  rules,
};
