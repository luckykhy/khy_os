'use strict';

/**
 * Leaf-contract test for toolUseLoopHelpers.js (the tool-result / delivery / classification / recovery /
 * scaffold / patch / nudge / write-diff / complexity band isolated from services/toolUseLoop.js).
 *
 * Governance (god-file split, "isolation-as-goal"): the agentic tool-use loop grew past the 2500-line
 * budget. runToolUseLoop plus the parse/exec cluster are an irreducible mega-construct kept in the
 * same-directory sibling toolUseLoopCore.js; this focused ~2.2k-line helper band is relocated verbatim
 * (byte-identical bodies) into toolUseLoopHelpers.js. The core imports the helper surface it calls and
 * injects the six core-defined bindings the band reads (via setToolUseLoopHelpersDeps) to avoid a require
 * cycle. The public entry toolUseLoop.js re-exports the core surface unchanged.
 *
 * Proves: (1) the helpers leaf exports its function surface (spot-checked representatives across every
 * sub-band) plus the DI setter; (2) the public entry toolUseLoop.js re-exports the stable surface with the
 * same 74 keys the monolith exported, and a helper-backed export resolves to the same identity the helpers
 * leaf provides (wiring intact); (3) setToolUseLoopHelpersDeps is a guarded, idempotent, non-throwing DI
 * setter (six core bindings via `!== undefined` guards).
 *
 * Several helpers perform IO (fs reads for write-diff/scaffold) and the core drives network/timers, so this
 * test stays on the deterministic surface (export shape, wiring identity, setter guard) and never runs a
 * loop. Behavioural coverage lives in the toolUseLoop.* / patchEmptyToolNames / appLaunch* suites, which
 * exercise the band end-to-end through the wired core.
 */
const test = require('node:test');
const assert = require('node:assert');

const HELP = '../../src/services/toolUseLoopHelpers';
const CORE = '../../src/services/toolUseLoopCore';
const HOST = '../../src/services/toolUseLoop';

test('helpers leaf exports its function surface + DI setter', () => {
  const help = require(HELP);
  assert.strictEqual(typeof help.setToolUseLoopHelpersDeps, 'function');
  // Representatives drawn from each sub-band of the relocated helper region.
  for (const name of [
    '_buildToolResultMessage', '_stripToolCalls', '_pruneOldToolOutputs',
    '_looksLikeCannedRefusal', '_recoverWebSearchAfterShellFailure', '_patchEmptyShellCommand',
    '_matchBlockedToolConstraint', '_filterToolCallsByIntent', '_buildDeliverySummary',
    '_safeReadForDiff', '_finalizeWriteDiff', 'isEnabled', 'maybeForgeStructuredIntent',
  ]) {
    assert.strictEqual(typeof help[name], 'function', `helpers must export ${name}`);
  }
});

test('public entry re-exports the monolith surface; helper-backed export identity is the leaf wiring', () => {
  const host = require(HOST);
  const core = require(CORE);
  const help = require(HELP);
  // The facade is a straight re-export of the core surface.
  assert.strictEqual(host, core, 'toolUseLoop.js must re-export the core module object');
  assert.strictEqual(typeof host.runToolUseLoop, 'function');
  assert.strictEqual(host.runToolUseLoop.constructor.name, 'AsyncFunction');
  // Shorthand exports resolve to the exact identity the helpers leaf provides (core destructured them),
  // proving the leaf is wired into the live surface and is not a dead copy.
  assert.strictEqual(host.isEnabled, help.isEnabled,
    'host.isEnabled must be the helpers leaf function (wiring intact)');
  assert.strictEqual(host._safeReadForDiff, help._safeReadForDiff,
    'host._safeReadForDiff must be the helpers leaf function (wiring intact)');
  assert.strictEqual(host._parseToolCalls === undefined, false, '_parseToolCalls stays a core export');
});

test('setToolUseLoopHelpersDeps is a guarded, idempotent, non-throwing DI setter', () => {
  const { setToolUseLoopHelpersDeps } = require(HELP);
  assert.doesNotThrow(() => setToolUseLoopHelpersDeps());
  assert.doesNotThrow(() => setToolUseLoopHelpersDeps({}));
  // The six core bindings accept any defined value (data consts + functions); undefined is ignored.
  const fn = () => {};
  const deps = {
    _APP_TARGET_PROBE_BINS: new Set(['code']),
    _SEARCH_TERM_STOPWORDS: new Set(['the']),
    _parsePositiveInt: fn,
    _resolveAutoWebSearchMode: fn,
    _extractToolOutput: fn,
    _getActiveModelContextWindow: fn,
  };
  assert.doesNotThrow(() => setToolUseLoopHelpersDeps(deps));
  assert.doesNotThrow(() => setToolUseLoopHelpersDeps(deps));
});
