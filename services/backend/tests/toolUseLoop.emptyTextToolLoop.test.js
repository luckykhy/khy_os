'use strict';

/**
 * toolUseLoop.emptyTextToolLoop.test.js — regression for the "WebFetch ✓ but no
 * output" bug: a weak model returns EMPTY assistant text WITH a tool_use block
 * every turn (re-fetching the same news), never writing a closing answer.
 *
 * Previously the empty-reply recovery (forced-summary → salvage → E01) was gated
 * on `!hasToolBlocks`, so it could never fire while every empty turn carried a
 * tool block. The loop spun until max-iterations and returned an empty
 * finalResponse → the CLI render gate printed nothing ("为什么没有输出").
 *
 * Fix: track the empty-text-with-tools streak; once it crosses the threshold AND
 * usable tool data exists, route the turn into the SAME recovery instead of
 * re-dispatching the tool forever.
 */

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';

const toolCalling = require('../src/services/toolCalling');
const toolUseLoop = require('../src/services/toolUseLoop');

describe('toolUseLoop — repeated empty-text + tool_use must break the loop, never silence', () => {
  let _origExecute;
  let _saved;

  before(() => {
    _saved = {
      gate: process.env.KHY_TASK_CAPABILITY_GATE,
      appr: process.env.KHY_EXEC_APPROVAL,
      streak: process.env.KHY_EMPTY_TEXT_TOOL_LOOP_MAX,
    };
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_EXEC_APPROVAL = 'off';
    process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS = '1';
    process.env.KHY_EMPTY_TEXT_TOOL_LOOP_MAX = '2';
  });

  after(() => {
    const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('KHY_TASK_CAPABILITY_GATE', _saved.gate);
    restore('KHY_EXEC_APPROVAL', _saved.appr);
    restore('KHY_EMPTY_TEXT_TOOL_LOOP_MAX', _saved.streak);
    delete process.env.KHY_TOOL_LOOP_RECOVERY_DELAY_MS;
  });

  beforeEach(() => { _origExecute = toolCalling.executeTool; });
  afterEach(() => { toolCalling.executeTool = _origExecute; });

  test('empty-text + webFetch every turn → forced-summary disables tools and the model writes the answer', async () => {
    toolCalling.executeTool = async () => ({
      success: true,
      url: 'http://www.xinhuanet.com',
      status: 200,
      content: '新华网今日要闻：经济、科技、国际三大版块更新。',
    });

    let calls = 0;
    let forcedNoTools = false;
    const chat = async (_msg, opts = {}) => {
      calls += 1;
      if (opts._forceNoTools === true) {
        // Tools suppressed → the model finally writes a real summary.
        forcedNoTools = true;
        return { reply: '今天的主要新闻：经济、科技与国际三方面均有更新。', stopReason: 'stop', provider: 'mock' };
      }
      // The pathology: empty text + another webFetch, every single turn.
      return {
        reply: '',
        toolUseBlocks: [{ type: 'tool_use', id: `t${calls}`, name: 'webFetch', input: { url: 'http://www.xinhuanet.com' } }],
        stopReason: 'tool_use',
        provider: 'mock',
        model: 'weak-model',
      };
    };

    const result = await toolUseLoop.runToolUseLoop('看看最新新闻', { chat, maxIterations: 10 });

    assert.ok(forcedNoTools, 'the streak break must trigger a forced no-tools summarization turn');
    assert.match(result.finalResponse, /主要新闻|经济/, 'a real answer is produced, not silence');
    assert.ok(result.finalResponse && result.finalResponse.trim().length > 0, 'finalResponse is never empty');
    assert.ok(result.iterations < 10, 'the loop breaks early, it does NOT spin to max iterations');
  });

  test('empty-text + tool every turn AND forced-summary also empty → salvages the gathered content (never empty)', async () => {
    toolCalling.executeTool = async () => ({
      success: true,
      url: 'http://www.people.com.cn',
      status: 200,
      content: '人民网头条：今日重要会议召开，多项政策发布。',
    });

    let calls = 0;
    const chat = async (_msg, opts = {}) => {
      calls += 1;
      if (opts._forceNoTools === true) {
        // Even with tools off, the weak model still writes nothing.
        return { reply: '', stopReason: 'stop', provider: 'mock' };
      }
      return {
        reply: '',
        toolUseBlocks: [{ type: 'tool_use', id: `t${calls}`, name: 'webFetch', input: { url: 'http://www.people.com.cn' } }],
        stopReason: 'tool_use',
        provider: 'mock',
        model: 'weak-model',
      };
    };

    const result = await toolUseLoop.runToolUseLoop('最近有什么新闻', { chat, maxIterations: 12 });

    assert.match(result.finalResponse, /人民网头条|重要会议/, 'the salvaged tool content is surfaced');
    assert.ok(result.finalResponse && result.finalResponse.trim().length > 0, 'finalResponse is never empty');
    assert.doesNotMatch(result.finalResponse, /未能生成有效回复/, 'real data is never discarded for the canned failure');
    assert.ok(result.iterations < 12, 'the loop terminates well before max iterations');
  });

  test('a single empty-text + tool turn (streak below threshold) still dispatches normally', async () => {
    // Guard against over-correction: the FIRST empty-text tool turn is legitimate
    // (call a tool with no preamble) and must dispatch, not be broken early.
    const executed = [];
    toolCalling.executeTool = async (name) => {
      executed.push(name);
      return { success: true, content: '抓取成功的正文内容。' };
    };

    let calls = 0;
    const chat = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          reply: '',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'webFetch', input: { url: 'http://x' } }],
          stopReason: 'tool_use',
          provider: 'mock',
        };
      }
      return { reply: '这是基于抓取内容的回答。', stopReason: 'stop', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop('抓一下', { chat, maxIterations: 5 });

    assert.equal(executed.length, 1, 'the single legitimate tool turn dispatched exactly once');
    assert.match(result.finalResponse, /基于抓取内容/, 'normal continuation to the real answer');
  });

  test('tools succeed then the summarization turn errors out → gathered results are salvaged, not discarded', async () => {
    // The live "web_search ✓ ×3 then 404 → no output" failure: iteration 1 runs a
    // successful search, iteration 2 (the closing summary) fails because every model
    // channel 404s / the retry budget is exhausted. The error-return path must
    // surface the gathered results, not throw them away for a bare error string.
    toolCalling.executeTool = async () => ({
      success: true,
      results: [
        { title: '不通过 AI 直接搜索的方法', url: 'http://example.com/1', snippet: '用浏览器访问 bing.com / baidu.com' },
        { title: 'Windows 本地搜索', url: 'http://example.com/2', snippet: '按 Win+S 搜索本地内容' },
      ],
    });

    let calls = 0;
    const chat = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          reply: '',
          toolUseBlocks: [{ type: 'tool_use', id: 't1', name: 'web_search', input: { query: '不通过 ai 搜索怎么做' } }],
          stopReason: 'tool_use',
          provider: 'mock',
        };
      }
      // Summarization turn: gateway exhausted → errorType, non-empty error reply.
      return { reply: '', errorType: 'network', stopReason: 'error', provider: 'mock' };
    };

    const result = await toolUseLoop.runToolUseLoop('我想不通过ai搜索怎么做', { chat, maxIterations: 6 });

    assert.match(result.finalResponse, /浏览器访问|本地搜索/, 'the gathered search results are surfaced');
    assert.ok(result.finalResponse && result.finalResponse.trim().length > 0, 'finalResponse is never empty');
    assert.match(result.finalResponse, /汇总阶段中断/, 'the error is disclosed as a footnote, not hidden');
  });

  test('first-call total outage (no successful tools) still returns the clean error, not a fake salvage', async () => {
    // Over-correction guard for the error-path salvage: with zero successful tool
    // results, the bare friendly error must be preserved (no salvage banner).
    toolCalling.executeTool = async () => ({ success: false, error: 'boom' });

    const chat = async () => ({ reply: '', errorType: 'auth', stopReason: 'error', provider: 'mock' });

    const result = await toolUseLoop.runToolUseLoop('你好', { chat, maxIterations: 4 });

    assert.doesNotMatch(result.finalResponse, /已检索到的结果/, 'no fabricated salvage banner when nothing was gathered');
    assert.match(result.finalResponse, /认证失败|API Key/, 'the clean auth error is preserved');
  });

  test('non-streaming adapter repeating the SAME planning preamble emits it once, not N times', async () => {
    // The "连着三条一句一模一样的话" bug: on IDE-token adapters (kiro) no text ever
    // streams, so the pre-tool planning sentence was re-emitted every loop pass.
    // A flaky channel that makes the model repeat the same preamble across retries
    // must NOT print it once per round — de-dup to a single emission per turn.
    toolCalling.executeTool = async () => ({ success: true, content: 'skill 列表：无 websearch 条目。' });

    const PREAMBLE = '先查一下当前可用的 skill 列表，确认 /websearch 是否存在。';
    let calls = 0;
    const chat = async () => {
      calls += 1;
      if (calls <= 3) {
        // Same planning preamble + a tool call, every round (non-streaming: chat
        // never invokes onChunk itself). Vary the tool input per round so the
        // tool-loop detector doesn't break the run — we are isolating the
        // PREAMBLE de-dup, not loop detection.
        return {
          reply: PREAMBLE,
          toolUseBlocks: [{ type: 'tool_use', id: `t${calls}`, name: 'DiscoverSkills', input: { q: 'websearch', round: calls } }],
          stopReason: 'tool_use',
          provider: 'mock',
        };
      }
      return { reply: '/websearch 不是已注册的 skill，所以无效。', stopReason: 'stop', provider: 'mock' };
    };

    const textChunks = [];
    const onChunk = (chunk) => { if (chunk && chunk.type === 'text' && chunk.text) textChunks.push(chunk.text); };

    const result = await toolUseLoop.runToolUseLoop('/websearch 为什么无法使用', {
      chat,
      maxIterations: 8,
      chatOpts: { onChunk },
    });

    const preambleEmits = textChunks.filter((t) => t.replace(/\s+/g, ' ').trim() === PREAMBLE.replace(/\s+/g, ' ').trim());
    assert.equal(preambleEmits.length, 1, 'the identical planning preamble is emitted exactly once, not once per round');
    assert.match(result.finalResponse, /不是已注册的 skill|无效/, 'the real answer still arrives');
  });
});
