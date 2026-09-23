'use strict';

/**
 * toolUseLoopMonitorStates.test.js — locks the C3-P5 extraction of the per-task
 * auxiliary monitor-state bootstrap out of runToolUseLoop into
 * services/domain/catalog/toolUseLoop/monitorState.js.
 *
 * The god-file split must be behavior-preserving, so this pins the leaf's contract
 * guarantees: (1) each handle is created from its injected module, (2) sub-agents
 * suppress course/reflect/fpf/promptRound but NOT attribution, (3) the byte-faithful
 * try-wrapping is preserved EXACTLY as it was in the loop body — course/reflect/
 * attribution are NOT try-wrapped (an absent module → null, but a throwing
 * createState()/createAttributionState() throws synchronously), while only fpf and
 * promptRound are individually contained (a throw → null / the round default). The
 * loop-level suites (toolUseLoopCourse / toolUseLoopFalsePositiveFix /
 * characterizationFpfWiring) already cover these handles end-to-end; this is the
 * unit-level lock on the deps-injection seam itself.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createLoopMonitorStates } = require('../../src/services/domain/catalog/toolUseLoop/monitorState');

const okModule = (tag) => ({
  isEnabled: () => true,
  createState: () => ({ tag }),
  looksLikeBugfixTask: () => true,
  countRound: () => 3,
  priorUserTextsFrom: () => [],
  createAttributionState: () => ({ attrTag: tag }),
});

describe('createLoopMonitorStates (C3-P5 leaf)', () => {
  test('all modules enabled → five handles built from their injected modules', () => {
    const out = createLoopMonitorStates({
      chatOpts: {},
      userMessage: 'fix the bug',
      initialMessages: [],
      courseMonitor: okModule('course'),
      adaptiveExec: okModule('reflect'),
      promptRounds: okModule('rounds'),
      fpfGuard: okModule('fpf'),
      actionAttribution: okModule('attr'),
    });
    assert.deepEqual(out.courseState, { tag: 'course' });
    assert.deepEqual(out.reflectState, { tag: 'reflect' });
    assert.deepEqual(out.attributionState, { attrTag: 'attr' });
    assert.equal(out.fpfState.tag, 'fpf');
    assert.equal(out.fpfState.bugfixIntent, true);
    assert.equal(out.promptRound, 3);
  });

  test('sub-agent → course/reflect/fpf/promptRound suppressed, attribution NOT suppressed', () => {
    const out = createLoopMonitorStates({
      chatOpts: { _isSubagent: true },
      userMessage: 'x',
      initialMessages: [],
      courseMonitor: okModule('course'),
      adaptiveExec: okModule('reflect'),
      promptRounds: okModule('rounds'),
      fpfGuard: okModule('fpf'),
      actionAttribution: okModule('attr'),
    });
    assert.equal(out.courseState, null);
    assert.equal(out.reflectState, null);
    assert.equal(out.fpfState, null);
    assert.equal(out.promptRound, 1);
    assert.deepEqual(out.attributionState, { attrTag: 'attr' });
  });

  test('absent modules (fail-soft) → all null / default, never throws', () => {
    assert.doesNotThrow(() =>
      createLoopMonitorStates({
        chatOpts: {},
        userMessage: 'x',
        initialMessages: [],
        courseMonitor: null,
        adaptiveExec: null,
        promptRounds: null,
        fpfGuard: null,
        actionAttribution: null,
      })
    );
    const out = createLoopMonitorStates({
      chatOpts: {},
      userMessage: 'x',
      initialMessages: [],
      courseMonitor: null,
      adaptiveExec: null,
      promptRounds: null,
      fpfGuard: null,
      actionAttribution: null,
    });
    assert.deepEqual(out, {
      courseState: null,
      reflectState: null,
      attributionState: null,
      fpfState: null,
      promptRound: 1,
    });
  });

  test('course/reflect throw synchronously (byte-faithful: NOT try-wrapped)', () => {
    const boom = { isEnabled: () => true, createState: () => { throw new Error('x'); } };
    assert.throws(
      () => createLoopMonitorStates({
        chatOpts: {},
        userMessage: 'x',
        initialMessages: [],
        courseMonitor: boom,
        adaptiveExec: null,
        promptRounds: null,
        fpfGuard: null,
        actionAttribution: null,
      }),
      /x/,
    );
    assert.throws(
      () => createLoopMonitorStates({
        chatOpts: {},
        userMessage: 'x',
        initialMessages: [],
        courseMonitor: null,
        adaptiveExec: boom,
        promptRounds: null,
        fpfGuard: null,
        actionAttribution: null,
      }),
      /x/,
    );
  });

  test('a throwing guarded path is contained (fpf/promptRound) → null / default', () => {
    const out = createLoopMonitorStates({
      chatOpts: {},
      userMessage: 'x',
      initialMessages: [],
      courseMonitor: null,
      adaptiveExec: null,
      promptRounds: { isEnabled: () => true, priorUserTextsFrom: () => { throw new Error('y'); } },
      fpfGuard: { isEnabled: () => true, createState: () => { throw new Error('x'); } },
      actionAttribution: null,
    });
    assert.equal(out.fpfState, null);
    assert.equal(out.promptRound, 1);
  });

  test('attribution throws synchronously (byte-faithful: NOT try-wrapped)', () => {
    assert.throws(
      () => createLoopMonitorStates({
        chatOpts: {},
        userMessage: 'x',
        initialMessages: [],
        courseMonitor: null,
        adaptiveExec: null,
        promptRounds: null,
        fpfGuard: null,
        actionAttribution: { createAttributionState: () => { throw new Error('z'); } },
      }),
      /z/,
    );
  });

  test('gate off (isEnabled false) → that handle null, others still built', () => {
    const out = createLoopMonitorStates({
      chatOpts: {},
      userMessage: 'x',
      initialMessages: [],
      courseMonitor: { isEnabled: () => false },
      adaptiveExec: okModule('reflect'),
      promptRounds: { isEnabled: () => false },
      fpfGuard: { isEnabled: () => false },
      actionAttribution: okModule('attr'),
    });
    assert.equal(out.courseState, null);
    assert.equal(out.promptRound, 1);
    assert.equal(out.fpfState, null);
    assert.deepEqual(out.reflectState, { tag: 'reflect' });
    assert.deepEqual(out.attributionState, { attrTag: 'attr' });
  });
});
