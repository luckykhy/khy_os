'use strict';

/**
 * toolUseLoop.toolUseEmptyText.test.js — regression for the intermittent
 * "只显示工具调用后就截断 / 抱歉，AI 未能生成有效回复" bug.
 *
 * Root cause: many non-Claude models (e.g. minimax-m2.1) return a VALID tool-use
 * turn carrying ONLY structured `toolUseBlocks` and an EMPTY assistant text reply.
 * The empty-reply terminal block (DESIGN-ARCH-046) fired on `!aiResult.reply`,
 * used `hasToolBlocks` only to skip the auto-retry, and then fell through to the
 * canned failure return — so the tool was NEVER dispatched. When the same model
 * happened to emit thinking text alongside the tool call, `reply` was non-empty
 * and it worked: hence the "断断续续" (intermittent) symptom.
 *
 * Fix: a tool-use turn with empty text must fall through to tool dispatch, not
 * the empty-reply dead-end. This test locks that: an empty-text tool_use turn
 * executes the tool and the loop continues to a real answer.
 *
 * Drives the real runToolUseLoop with a counting fake chat and a monkeypatched
 * toolCalling.executeTool (property access at call time). Zero network/process.
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Set tool-gating env BEFORE requiring the modules — some gates read these at
// load time. This suite tests dispatch/salvage, not the capability gate/approval.
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');

describe('toolUseLoop — empty-TEXT tool-use turn must execute the tool (not bail)', () => {
  let _origExecute;
  let _savedGate;
  let _savedApproval;

  before(() => {
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    _savedApproval = process.env.KHY_EXEC_APPROVAL;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_EXEC_APPROVAL = 'off'; // this suite tests dispatch, not approval
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
  });

  after(() => {
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
    if (_savedApproval === undefined) delete process.env.KHY_EXEC_APPROVAL;
    else process.env.KHY_EXEC_APPROVAL = _savedApproval;
    delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS;
  });

  beforeEach(() => { _origExecute = toolCalling.executeTool; });
  afterEach(() => { toolCalling.executeTool = _origExecute; });

  test('reply="" + structured toolUseBlocks → tool executes, loop yields a real answer', async () => {
    const executed = [];
    toolCalling.executeTool = async (name, params) => {
      executed.push({ name, params });
      // The loop canonicalizes tool names (web_search → webSearch); match loosely.
      if (/search/i.test(name)) {
        return { success: true, results: [{ title: '新闻1' }, { title: '新闻2' }], output: 'web ok' };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    };

    let calls = 0;
    const chat = async () => {
      calls += 1;
      if (calls === 1) {
        // The bug repro: a tool-use turn with NO assistant text.
        return {
          reply: '',
          toolUseBlocks: [
            { type: 'tool_use', id: 't1', name: 'web_search', input: { query: '中国最新新闻' } },
          ],
          stopReason: 'tool_use',
          provider: 'mock',
          model: 'minimax-m2.1',
        };
      }
      // Continuation after the tool result: the real answer.
      return { reply: '以下是今天的中国新闻……', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop('中国的新闻', { chat, maxIterations: 5 });

    assert.ok(
      executed.some((c) => /search/i.test(c.name)),
      'the empty-text tool-use turn MUST dispatch the tool (previously it was never executed)',
    );
    assert.match(result.finalResponse, /中国新闻/, 'the loop continues to the real answer');
    assert.doesNotMatch(
      result.finalResponse, /未能生成有效回复/,
      'must NOT return the canned empty-reply failure on a valid tool-use turn',
    );
    assert.notEqual(result.errorType, 'empty_reply', 'a valid tool-use turn is not an empty-reply error');
  });

  test('reply="" AND no toolUseBlocks → genuinely empty, still gets bounded recovery/fallback', async () => {
    toolCalling.executeTool = async () => ({ success: false, error: 'should not be called' });

    let calls = 0;
    const chat = async () => {
      calls += 1;
      return { reply: '', stopReason: 'stop', provider: 'mock' }; // truly empty, no tools
    };

    const result = await toolUseLoop.runToolUseLoop('你是什么模型', { chat, maxIterations: 5 });

    assert.ok(calls >= 2, 'a genuinely empty reply still triggers the bounded auto-retry');
    assert.match(result.finalResponse, /未能生成有效回复/, 'exhausted recovery still yields the canned fallback');
    assert.equal(result.error_code, 'E01', 'fallback keeps its E01 attribution');
  });

  test('SALVAGE: tool succeeds but continuation is empty → gathered data is surfaced, not discarded', async () => {
    // Reproduces "工具调用显示绿色但还是没输出": the tool runs (✓) but the model
    // writes no closing text. The gathered results must be shown, never dropped
    // for a bare "未能生成有效回复".
    toolCalling.executeTool = async () => ({
      success: true,
      results: [{ title: '新闻1' }, { title: '新闻2' }],
      output: 'News for "中国": 8 article(s) via web: 1. Xinhua Headline …',
    });

    let calls = 0;
    const chat = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          reply: '',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'news', input: { query: '中国 最新新闻' } }],
          stopReason: 'tool_use',
          provider: 'mock',
          model: 'sensenova-6.7-flash-lite',
        };
      }
      // Continuation after the tool result: model returns empty (the real bug).
      return { reply: '', stopReason: 'stop', provider: 'mock', model: 'sensenova-6.7-flash-lite' };
    };

    const result = await toolUseLoop.runToolUseLoop('最近新闻', { chat, maxIterations: 5 });

    assert.match(result.finalResponse, /8 article|Xinhua|新闻/, 'the fetched data is surfaced to the user');
    assert.doesNotMatch(result.finalResponse, /未能生成有效回复/, 'never discard real data for the canned failure');
    assert.equal(result.salvaged, true, 'the turn is flagged as salvaged (real content, kept in history)');
    assert.notEqual(result.error_code, 'E01', 'salvaged content is not an empty-reply failure');
  });

  test('FORCED SUMMARY: tool succeeds, continuation empty → a no-tools re-ask produces a real summary BEFORE raw salvage', async () => {
    // The "成品优先" path: when the model finishes its tool call but writes no
    // closing text, the loop must ask ONCE more with tools disabled and let the
    // model write a genuine summary — surfacing that, NOT the raw tool dump.
    toolCalling.executeTool = async () => ({
      success: true,
      results: [{ title: '新闻1' }, { title: '新闻2' }],
      output: 'News for "中国": 8 article(s) via web: 1. Xinhua Headline …',
    });

    let calls = 0;
    let forcedTurnSawNoTools = false;
    const chat = async (_msg, chatOpts = {}) => {
      calls += 1;
      if (calls === 1) {
        // First turn: a tool-use turn with no assistant text.
        return {
          reply: '',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'news', input: { query: '中国 最新新闻' } }],
          stopReason: 'tool_use',
          provider: 'mock',
          model: 'sensenova-6.7-flash-lite',
        };
      }
      if (calls === 2) {
        // Continuation after the tool result: model returns empty (the real bug).
        return { reply: '', stopReason: 'stop', provider: 'mock', model: 'sensenova-6.7-flash-lite' };
      }
      // Third turn = the forced-summarization re-ask. It MUST arrive with tools
      // suppressed, and here the model finally writes a proper summary.
      forcedTurnSawNoTools = chatOpts._forceNoTools === true;
      return {
        reply: '总结：今天中国共有 8 条重要新闻，包括新华社头条……',
        stopReason: 'stop',
        provider: 'mock',
        model: 'sensenova-6.7-flash-lite',
      };
    };

    const result = await toolUseLoop.runToolUseLoop('最近新闻', { chat, maxIterations: 6 });

    assert.ok(forcedTurnSawNoTools, 'the forced-summary turn MUST be sent with tools disabled (_forceNoTools)');
    assert.match(result.finalResponse, /总结：今天中国/, 'the model-written summary is surfaced (成品优先)');
    assert.notEqual(result.salvaged, true, 'a real model summary is NOT a raw-data salvage');
    assert.doesNotMatch(result.finalResponse, /未能生成有效回复/, 'never the canned failure when a summary was produced');
    assert.notEqual(result.error_code, 'E01', 'a produced summary is not an empty-reply failure');
  });

  test('FORCED SUMMARY exhausted → still empty falls through to raw-data salvage (原料兜底)', async () => {
    // If the forced no-tools re-ask ALSO returns empty, the loop must not loop
    // forever: it falls to the raw-data salvage floor (bounded by forcedSummaryMax=1).
    toolCalling.executeTool = async () => ({
      success: true,
      results: [{ title: '新闻1' }],
      output: 'News for "中国": 8 article(s) via web: 1. Xinhua Headline …',
    });

    let calls = 0;
    let forcedTurns = 0;
    const chat = async (_msg, chatOpts = {}) => {
      calls += 1;
      if (chatOpts._forceNoTools === true) forcedTurns += 1;
      if (calls === 1) {
        return {
          reply: '',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'news', input: { query: '中国' } }],
          stopReason: 'tool_use',
          provider: 'mock',
          model: 'sensenova-6.7-flash-lite',
        };
      }
      // Every continuation (including the forced-summary turn) returns empty.
      return { reply: '', stopReason: 'stop', provider: 'mock', model: 'sensenova-6.7-flash-lite' };
    };

    const result = await toolUseLoop.runToolUseLoop('最近新闻', { chat, maxIterations: 8 });

    assert.equal(forcedTurns, 1, 'the forced-summary turn fires exactly once (bounded, never loops)');
    assert.match(result.finalResponse, /8 article|Xinhua|新闻/, 'falls back to the raw gathered data');
    assert.equal(result.salvaged, true, 'the floor is the raw-data salvage');
    assert.doesNotMatch(result.finalResponse, /未能生成有效回复/, 'never the canned failure when data exists');
  });
});
