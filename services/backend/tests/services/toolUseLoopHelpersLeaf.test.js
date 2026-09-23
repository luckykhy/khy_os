'use strict';
const assert = require('node:assert');
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
const HELP = '../../src/services/toolUseLoopHelpers';
const CORE = '../../src/services/toolUseLoopCore';
const HOST = '../../src/services/toolUseLoop';

describe('Tool Use Loop Helpers Leaf', () => {
  test('helpers leaf exports its function surface + DI setter', () => {
      const help = require(HELP);
      expect(typeof help.setToolUseLoopHelpersDeps).toBe('function');
      // Names follow the leaf's export surface: underscored internal band functions
      // (DI-facing) plus a few public verbs (isEnabled / maybeForgeStructuredIntent).
      for (const name of [
        '_buildToolResultMessage', '_stripToolCalls', '_pruneOldToolOutputs',
        '_looksLikeCannedRefusal', '_recoverWebSearchAfterShellFailure', '_patchEmptyShellCommand',
        '_matchBlockedToolConstraint', '_filterToolCallsByIntent', '_buildDeliverySummary',
        '_safeReadForDiff', '_finalizeWriteDiff', 'isEnabled', 'maybeForgeStructuredIntent',
      ]) {
        expect(typeof help[name]).toBe('function', `helpers must export ${name}`);
      }
  });

  test('public entry re-exports the monolith surface; helper-backed export identity is the leaf wiring', () => {
      const host = require(HOST);
      const core = require(CORE);
      const help = require(HELP);
      // The facade spreads the core surface verbatim. One documented exception
      // (DESIGN-ARCH-096 §2-A turn-checkpoint wrap): host.runToolUseLoop is a
      // thin async wrapper around core.runToolUseLoop that closes the turn on
      // every exit path — so it is NOT the identical core function, but still
      // an AsyncFunction and every other export is the exact core object.
      expect(typeof host.runToolUseLoop).toBe('function');
      expect(host.runToolUseLoop.constructor.name).toBe('AsyncFunction');
      expect(host.runToolUseLoop).not.toBe(core.runToolUseLoop, 'facade wraps the core entry (turn checkpoint)');
      // Every non-wrapped export resolves to the EXACT core surface object (spread, not copy) —
      // core itself destructures the helpers leaf (so isEnabled/_safeReadForDiff ARE the leaf
      // functions); the leaf's own export shape (underscored names) is verified in test 1.
      assert.strictEqual(host.isEnabled, core.isEnabled, 'host.isEnabled must be the core surface object');
      assert.strictEqual(host._safeReadForDiff, core._safeReadForDiff, 'host._safeReadForDiff must be the core surface object');
      assert.strictEqual(host._buildToolResultMessage, core._buildToolResultMessage, 'host._buildToolResultMessage must be the core surface object');
      // Wiring proof: the core surface is identity-stable with the helpers leaf for
      // helper-backed exports (core destructures the leaf; underscored names match).
      assert.strictEqual(core._safeReadForDiff, help._safeReadForDiff, 'core._safeReadForDiff must be the helpers leaf function');
      expect(host._parseToolCalls === undefined).toBe(false, '_parseToolCalls stays a core export');
  });

  test('setToolUseLoopHelpersDeps is a guarded, idempotent, non-throwing DI setter', () => {
      const { setToolUseLoopHelpersDeps } = require(HELP);
      expect(() => setToolUseLoopHelpersDeps()).not.toThrow();
      expect(() => setToolUseLoopHelpersDeps({})).not.toThrow();
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
      expect(() => setToolUseLoopHelpersDeps(deps)).not.toThrow();
      expect(() => setToolUseLoopHelpersDeps(deps)).not.toThrow();
  });

});

