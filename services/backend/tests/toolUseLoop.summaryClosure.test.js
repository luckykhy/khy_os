'use strict';

/**
 * toolUseLoop.summaryClosure.test.js — regression for the user-reported
 * "只有过程没有总结" bug.
 *
 * Symptom: the user asks an informational/summary question (e.g. "做个总结桌面上
 * 有些什么"), the model runs a read-only tool (`dir`), the raw tool output is
 * shown, and then NO natural-language summary is produced — the turn ends on the
 * process output. Two weak-model shapes cause this even though the empty-reply
 * salvage machinery already covers a *blank* continuation:
 *
 *   (B) bare acknowledgement — the continuation is just "好的。", carrying no
 *       summary. Previously it slipped past the tier-independent closure guard
 *       and got a statistics template tail instead of a real summary.
 *   (C) tool-output echo — the continuation pastes the directory listing back
 *       verbatim. Substantive enough to dodge every "are you done?" heuristic,
 *       so it was delivered as the "answer" (= process, no summary).
 *
 * Fix: the model-tier-independent closure guard now also treats a bare ack and a
 * verbatim tool-output echo as "干了活却没交付", forcing exactly ONE no-tools
 * round that demands a real summary. Bounded (one-shot) so an uncooperative model
 * never loops; it then falls back to surfacing the data.
 *
 * Drives the real runToolUseLoop with a counting fake chat and a monkeypatched
 * toolCalling.executeTool. Zero network/process.
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');

const DIR_OUTPUT = [
  'KHY-Documents', 'KHY-Executables', 'linghun.lnk', 'Nirvana',
  '项目', '毕业论文', '旅游',
].join('\n');
const REAL_SUMMARY = '你的桌面上一共有 7 项，主要包括：项目相关文件夹（KHY-Documents、KHY-Executables、项目）、'
  + '个人材料（毕业论文、旅游）以及若干快捷方式（linghun.lnk、Nirvana）。';

describe('toolUseLoop — summary closure (只有过程没有总结)', () => {
  let _origExecute;

  before(() => { process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1'; });
  after(() => { delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS; });
  beforeEach(() => {
    _origExecute = toolCalling.executeTool;
    toolCalling.executeTool = async () => ({ success: true, output: DIR_OUTPUT });
  });
  afterEach(() => { toolCalling.executeTool = _origExecute; });

  test('bare ack continuation → forced no-tools round produces a real summary', async () => {
    let forcedNoTools = false;
    let calls = 0;
    const chat = async (_msg, opts = {}) => {
      if (opts._forceNoTools === true) forcedNoTools = true;
      calls += 1;
      if (calls === 1) {
        return {
          reply: '', stopReason: 'tool_use', provider: 'mock', model: 'deepseek-v4-flash',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'shell_command', input: { command: 'dir /b' } }],
        };
      }
      if (opts._forceNoTools === true) return { reply: REAL_SUMMARY, stopReason: 'stop', provider: 'mock' };
      return { reply: '好的。', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop('做个总结桌面上有些什么', { chat, maxIterations: 8 });
    assert.ok(forcedNoTools, 'a bare ack after tool work MUST trigger a no-tools summary round');
    assert.match(result.finalResponse, /主要包括|一共有 7 项/, 'the forced round surfaces a real summary');
    assert.doesNotMatch(result.finalResponse, /^好的。$/, 'the bare ack is not the final answer');
  });

  test('tool-output echo continuation → forced no-tools round produces a real summary', async () => {
    let forcedNoTools = false;
    let calls = 0;
    const chat = async (_msg, opts = {}) => {
      if (opts._forceNoTools === true) forcedNoTools = true;
      calls += 1;
      if (calls === 1) {
        return {
          reply: '', stopReason: 'tool_use', provider: 'mock', model: 'deepseek-v4-flash',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'shell_command', input: { command: 'dir /b' } }],
        };
      }
      if (opts._forceNoTools === true) return { reply: REAL_SUMMARY, stopReason: 'stop', provider: 'mock' };
      return { reply: DIR_OUTPUT, stopReason: 'stop', provider: 'mock' }; // echoes the listing
    };

    const result = await toolUseLoop.runToolUseLoop('做个总结桌面上有些什么', { chat, maxIterations: 8 });
    assert.ok(forcedNoTools, 'a verbatim tool-output echo MUST trigger a no-tools summary round');
    assert.match(result.finalResponse, /主要包括|一共有 7 项/, 'the forced round surfaces a real summary');
  });

  test('a genuine summary on the first continuation is accepted as-is (no extra round)', async () => {
    let forcedNoTools = false;
    let calls = 0;
    const chat = async (_msg, opts = {}) => {
      if (opts._forceNoTools === true) forcedNoTools = true;
      calls += 1;
      if (calls === 1) {
        return {
          reply: '', stopReason: 'tool_use', provider: 'mock', model: 'deepseek-v4-flash',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'shell_command', input: { command: 'dir /b' } }],
        };
      }
      return { reply: REAL_SUMMARY, stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop('做个总结桌面上有些什么', { chat, maxIterations: 8 });
    assert.equal(forcedNoTools, false, 'a real summary must NOT be re-nudged for a redundant round');
    assert.match(result.finalResponse, /主要包括/, 'the genuine summary is delivered unchanged');
  });

  test('uncooperative model that keeps echoing → closure fires once, never loops', async () => {
    let forcedCount = 0;
    let calls = 0;
    const chat = async (_msg, opts = {}) => {
      if (opts._forceNoTools === true) forcedCount += 1;
      calls += 1;
      if (calls === 1) {
        return {
          reply: '', stopReason: 'tool_use', provider: 'mock', model: 'deepseek-v4-flash',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'shell_command', input: { command: 'dir /b' } }],
        };
      }
      return { reply: DIR_OUTPUT, stopReason: 'stop', provider: 'mock' }; // always echoes
    };

    const result = await toolUseLoop.runToolUseLoop('做个总结桌面上有些什么', { chat, maxIterations: 8 });
    assert.equal(forcedCount, 1, 'the closure guard is one-shot — exactly one forced round, no infinite loop');
    assert.ok(calls <= 4, 'the loop terminates promptly instead of burning iterations');
    assert.match(result.finalResponse, /KHY-Documents|项目/, 'the gathered data is still surfaced as a fallback');
  });
});
