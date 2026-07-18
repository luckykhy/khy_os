'use strict';

/**
 * toolUseLoop.circuitBreakerNoTools.test.js — regression for the "绕圈子" bug:
 * after the loop detector's CIRCUIT BREAKER (hard backstop) trips, a weak model
 * ignored the inline [STOP] tool_result and kept emitting filler
 * ("Let me use the right tools…") plus more doomed tool calls, then an empty/
 * hollow answer.
 *
 * Fix: once the circuit breaker trips, arm a ONE-SHOT tools-free closing turn
 * (_forceNoTools) with a terminal instruction so the model can only write a
 * final text answer from what it already has. If it trips AGAIN (never
 * converges), bail with salvage instead of looping the nudge.
 *
 * Drives the real runToolUseLoop with a counting fake chat + monkeypatched
 * toolCalling.executeTool. Zero network/process. The circuit-breaker threshold
 * is lowered via env so the trip happens after a couple of distinct calls.
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');

describe('toolUseLoop — circuit breaker forces a tools-free closing turn (no 绕圈子)', () => {
  let _origExecute;
  let _saved = {};

  before(() => {
    _saved.gate = process.env.KHY_TASK_CAPABILITY_GATE;
    _saved.approval = process.env.KHY_EXEC_APPROVAL;
    _saved.breaker = process.env.KHY_TOOL_CIRCUIT_BREAKER_THRESHOLD;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_EXEC_APPROVAL = 'off';
    // Trip the hard backstop quickly: 3 total tool calls.
    process.env.KHY_TOOL_CIRCUIT_BREAKER_THRESHOLD = '3';
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
  });

  after(() => {
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('KHY_TASK_CAPABILITY_GATE', _saved.gate);
    restore('KHY_EXEC_APPROVAL', _saved.approval);
    restore('KHY_TOOL_CIRCUIT_BREAKER_THRESHOLD', _saved.breaker);
    delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS;
  });

  beforeEach(() => { _origExecute = toolCalling.executeTool; });
  afterEach(() => { toolCalling.executeTool = _origExecute; });

  // A model that keeps issuing DISTINCT glob calls (so per-call dedup/critical
  // detectors don't catch it first — only the global circuit breaker does),
  // then, once tools are taken away, writes a real answer.
  function makeDistinctGlobChat(onForcedTurn) {
    let n = 0;
    return async (_msg, chatOpts = {}) => {
      if (chatOpts._forceNoTools === true) {
        return onForcedTurn(chatOpts);
      }
      n += 1;
      return {
        reply: 'Let me use the right tools to explore the structure more carefully',
        toolUseBlocks: [
          { type: 'tool_use', id: `g${n}`, name: 'glob', input: { pattern: `dir${n}/**` } },
        ],
        stopReason: 'tool_use',
        provider: 'mock',
        model: 'weak-mini',
      };
    };
  }

  test('breaker trip → next turn is tools-free and the model produces a real answer', async () => {
    toolCalling.executeTool = async () => ({ success: true, output: 'no matches', results: [] });

    let forcedSawNoTools = false;
    const chat = makeDistinctGlobChat((chatOpts) => {
      forcedSawNoTools = chatOpts._forceNoTools === true;
      return {
        reply: '根据已有信息，khy OS 的结构无法进一步定位，这是我的评价：……',
        stopReason: 'stop',
        provider: 'mock',
        model: 'weak-mini',
      };
    });

    const result = await toolUseLoop.runToolUseLoop('评价一下 khy OS', { chat, maxIterations: 12 });

    assert.ok(forcedSawNoTools, 'the post-breaker closing turn MUST be sent with tools disabled (_forceNoTools)');
    assert.match(result.finalResponse, /这是我的评价/, 'the model writes a real text answer once tools are removed');
    assert.doesNotMatch(result.finalResponse, /Let me use the right tools/, 'the filler preamble is not surfaced as the answer');
  });

  test('breaker trips, model STILL emits tool calls even tools-free → bails with salvage, no infinite 绕圈子', async () => {
    toolCalling.executeTool = async () => ({ success: true, output: 'no matches', results: [] });

    // Worst case: even on the forced tools-free turn the model keeps emitting a
    // text-based <tool_call> (some weak models ignore the missing tool defs).
    // The breaker re-trips → the loop must BAIL with salvage, not re-arm the
    // nudge forever.
    let forcedTurns = 0;
    let totalTurns = 0;
    const chat = async (_msg, chatOpts = {}) => {
      totalTurns += 1;
      if (chatOpts._forceNoTools === true) forcedTurns += 1;
      return {
        reply: 'Let me use the right tools to explore the structure more carefully',
        toolUseBlocks: [{ type: 'tool_use', id: `g${totalTurns}`, name: 'glob', input: { pattern: `p${totalTurns}/**` } }],
        stopReason: 'tool_use',
        provider: 'mock',
        model: 'weak-mini',
      };
    };

    const result = await toolUseLoop.runToolUseLoop('评价一下 khy OS', { chat, maxIterations: 30 });

    assert.ok(forcedTurns <= 1, `the tools-free closing turn is armed at most once (was ${forcedTurns})`);
    assert.ok(totalTurns < 30, `the loop terminates well before maxIterations (was ${totalTurns})`);
    assert.equal(result.stopped, true, 'a non-converging run ends in a bounded stop');
    assert.equal(result.loopDetected, true, 'the bail is attributed to loop detection');
    assert.match(result.finalResponse, /循环保护/, 'the salvage answer explains the loop guard tripped');
  });
});
