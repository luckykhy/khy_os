'use strict';

// [AI-弱模型·照抄] 本文件是受监控的高危位点(见 scripts/ci/check-change-safety.js 的
// WEAK_MODEL_BANNER_FILES):改这里之前先读 services/backend/src/services/weakModelGuidance.js
// 的 GUARD_SITES / bannerFor(),照抄它给的护栏文案与范例,别凭记忆重写。这里是薄壳,
// 只做 re-export + 出口包一层;真正的循环逻辑在 toolUseLoopCore.js(本横幅的来源见该文件)。

/**
 * toolUseLoop — public entry (facade).
 *
 * The agentic tool-use loop is split across two same-directory siblings for maintainability:
 *   - toolUseLoopCore.js    : requires + header substrate + runToolUseLoop + the parse/exec cluster
 *                             (the irreducible mega-construct) plus the public module.exports surface.
 *   - toolUseLoopHelpers.js : the tool-result / delivery / classification / recovery / scaffold / patch /
 *                             nudge / write-diff / complexity band the core calls.
 * The core wires the helpers together and owns the exports, so this entry simply re-exports the core
 * surface unchanged — every existing `require("./toolUseLoop")` consumer sees the identical object.
 *
 * ONE additive wrap (DESIGN-ARCH-096 §2-A, 按回合原子回滚): the core's `runToolUseLoop`
 * opens a turn via `turnCheckpointService.beginTurn()` at its entry but has many scattered
 * return/throw exits, so there is no single in-core "turn end" point. We therefore wrap the
 * exported `runToolUseLoop` with a try/finally that closes the turn on EVERY exit path
 * (normal return, error, interrupt). This is fail-soft and additive:
 *   - `_turnId` is read from the core's mutated `options._turnId` (set at loop start).
 *   - a null/absent turn id (core failed to open one, or feature off) → endTurn is skipped.
 *   - endTurn itself is wrapped so a storage error can never affect the loop result.
 * Every OTHER export passes through untouched, so consumers that only import helpers see
 * the identical objects as before.
 */
const core = require('./toolUseLoopCore');

function _endTurnSafe(turnId) {
  if (!turnId) {
    return;
  }
  try {
    require('../turnCheckpointService').endTurn(turnId);
  } catch {
    /* fail-soft: closing a turn must never affect the agent loop result */
  }
}

const wrappedRunToolUseLoop = async (userMessage, options = {}) => {
  try {
    const result = await core.runToolUseLoop(userMessage, options);
    return result;
  } finally {
    // options is mutated in place by the core (`options._turnId = ...`), so the
    // closed turn id is readable here on every exit path, including a throw.
    _endTurnSafe(options && options._turnId);
  }
};

module.exports = { ...core, runToolUseLoop: wrappedRunToolUseLoop };
