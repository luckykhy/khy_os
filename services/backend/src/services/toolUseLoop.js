'use strict';

/**
 * toolUseLoop — public entry (facade).
 *
 * The agentic tool-use loop is split across two same-directory siblings for maintainability:
 *   - toolUseLoopCore.js    : requires + header substrate + runToolUseLoop + the parse/exec cluster
 *                             (the irreducible mega-construct) plus the public module.exports surface.
 *   - toolUseLoopHelpers.js : the tool-result / delivery / classification / recovery / scaffold / patch /
 *                             nudge / write-diff / complexity band the core calls.
 * The core wires the helpers together and owns the exports, so this entry simply re-exports the core
 * surface unchanged — every existing `require(".../toolUseLoop")` consumer sees the identical object.
 */
module.exports = require('./toolUseLoopCore');
