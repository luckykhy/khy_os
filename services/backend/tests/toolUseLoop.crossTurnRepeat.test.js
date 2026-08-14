'use strict';

/**
 * toolUseLoop.crossTurnRepeat.test.js — the「怎么又反复陷入了循环 / 此路不通不换一条」
 * fix. A real Windows session: each「继续」was a NEW turn, so the per-turn loop
 * detector reset and the model silently re-ran the SAME successful `dir /s /b`,
 * salvage-dumping the raw listing instead of writing the requested table.
 *
 * The cross-turn guard threads the recent successful tool-call signatures into
 * the loop; before dispatch it steers a re-issued, already-answered call to
 * answer-from-context OR switch approach — without executing it — bounded by a
 * per-turn cap so the steer itself can never loop. Dormant unless the caller
 * supplies recentToolSignatures (backward-compatible).
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');

// The reported call: list the desktop recursively. We harvest the signature the
// SAME way a real caller does — via _signatureForCall on the (name, params) the
// loop reports — so the seed matches the form the guard recomputes pre-dispatch.
// (Shell commands match on the command-derived INTENT key, which is robust to the
// host-platform command rewrite the loop applies between guard and onToolResult.)
const DESKTOP_CMD = 'dir "D:\\HuaweiMoveData\\Users\\25789\\Desktop" /s /b';
const DESKTOP_HARVEST = toolUseLoop._signatureForCall('bash', { command: DESKTOP_CMD }, null);
const RECENT_DESKTOP = {
  exact: [DESKTOP_HARVEST.sig].filter(Boolean),
  intents: [DESKTOP_HARVEST.intentKey].filter(Boolean),
};

describe('crossTurnRepeatDecision (pure)', () => {
  const call = { name: 'bash', params: { command: DESKTOP_CMD } };
  const recent = toolUseLoop._normalizeRecentSignatures(RECENT_DESKTOP);

  test('a call matching a recent successful signature steers (once) with a 二选一 message', () => {
    const state = { counts: new Map(), cap: 1 };
    const d = toolUseLoop.crossTurnRepeatDecision(call, recent, state, { KHY_CROSS_TURN_TOOL_DEDUP: '1' });
    assert.equal(d.steer, true);
    assert.match(d.message, /已经成功运行过/);
    assert.match(d.message, /此路不通/);
  });

  test('bounded by cap: once exhausted the call falls through and executes', () => {
    const state = { counts: new Map(), cap: 1 };
    assert.equal(toolUseLoop.crossTurnRepeatDecision(call, recent, state, {}).steer, true);
    assert.equal(toolUseLoop.crossTurnRepeatDecision(call, recent, state, {}).steer, false);
  });

  test('master kill-switch KHY_CROSS_TURN_TOOL_DEDUP=0 → never steers', () => {
    const state = { counts: new Map(), cap: 1 };
    assert.equal(toolUseLoop.crossTurnRepeatDecision(call, recent, state, { KHY_CROSS_TURN_TOOL_DEDUP: '0' }).steer, false);
  });

  test('a non-matching call is untouched', () => {
    const state = { counts: new Map(), cap: 1 };
    const other = { name: 'bash', params: { command: 'echo hello' } };
    assert.equal(toolUseLoop.crossTurnRepeatDecision(other, recent, state, {}).steer, false);
  });

  test('empty recent signatures → never steers (dormant for fresh sessions)', () => {
    const empty = toolUseLoop._normalizeRecentSignatures(null);
    const state = { counts: new Map(), cap: 1 };
    assert.equal(toolUseLoop.crossTurnRepeatDecision(call, empty, state, {}).steer, false);
  });

  test('never throws on garbage', () => {
    assert.doesNotThrow(() => toolUseLoop.crossTurnRepeatDecision(null, null, null, {}));
    assert.equal(toolUseLoop.crossTurnRepeatDecision(null, recent, {}, {}).steer, false);
  });
});

describe('runToolUseLoop — cross-turn repeat is steered, not re-executed', () => {
  let _origExecute;
  let _saved;

  before(() => {
    _saved = {
      gate: process.env.KHY_TASK_CAPABILITY_GATE,
      appr: process.env.KHY_EXEC_APPROVAL,
      dedup: process.env.KHY_CROSS_TURN_TOOL_DEDUP,
    };
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_EXEC_APPROVAL = 'off';
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
  });

  after(() => {
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('KHY_TASK_CAPABILITY_GATE', _saved.gate);
    restore('KHY_EXEC_APPROVAL', _saved.appr);
    restore('KHY_CROSS_TURN_TOOL_DEDUP', _saved.dedup);
    delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS;
  });

  beforeEach(() => { _origExecute = toolCalling.executeTool; });
  afterEach(() => { toolCalling.executeTool = _origExecute; });

  test('a re-issued already-answered command is NOT executed; the model is steered to answer', async () => {
    process.env.KHY_CROSS_TURN_TOOL_DEDUP = '1';
    let executed = 0;
    toolCalling.executeTool = async () => { executed += 1; return { success: true, content: 'a.txt\nb.txt' }; };

    let calls = 0;
    const chat = async (_msg, opts = {}) => {
      calls += 1;
      // First model turn: re-issue the SAME dir the prior turn already ran.
      if (calls === 1) {
        return {
          reply: '',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: DESKTOP_CMD } }],
          stopReason: 'tool_use',
          provider: 'mock',
        };
      }
      // After the steer lands in the tool result, the model writes the answer.
      return { reply: '可删除文件：a.txt、b.txt。', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop('列出来', {
      chat,
      maxIterations: 6,
      recentToolSignatures: RECENT_DESKTOP,
    });

    assert.equal(executed, 0, 'the already-answered command must NOT re-execute');
    assert.match(result.finalResponse, /可删除文件/, 'the model produces the requested answer after the steer');
  });

  test('KHY_CROSS_TURN_TOOL_DEDUP=0 disables the guard → the command executes', async () => {
    process.env.KHY_CROSS_TURN_TOOL_DEDUP = '0';
    let executed = 0;
    toolCalling.executeTool = async () => { executed += 1; return { success: true, content: 'a.txt' }; };

    let calls = 0;
    const chat = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          reply: '',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: DESKTOP_CMD } }],
          stopReason: 'tool_use',
          provider: 'mock',
        };
      }
      return { reply: '完成。', stopReason: 'stop', provider: 'mock' };
    };

    await toolUseLoop.runToolUseLoop('列出来', {
      chat,
      maxIterations: 6,
      recentToolSignatures: RECENT_DESKTOP,
    });

    assert.equal(executed, 1, 'with the guard off the command runs normally');
  });

  test('backward-compat: no recentToolSignatures → unchanged, the command executes', async () => {
    process.env.KHY_CROSS_TURN_TOOL_DEDUP = '1';
    let executed = 0;
    toolCalling.executeTool = async () => { executed += 1; return { success: true, content: 'a.txt' }; };

    let calls = 0;
    const chat = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          reply: '',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: DESKTOP_CMD } }],
          stopReason: 'tool_use',
          provider: 'mock',
        };
      }
      return { reply: '完成。', stopReason: 'stop', provider: 'mock' };
    };

    await toolUseLoop.runToolUseLoop('列出来', { chat, maxIterations: 6 });

    assert.equal(executed, 1, 'dormant without recentToolSignatures — older callers are unaffected');
  });
});
