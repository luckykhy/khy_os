'use strict';

/**
 * multiFreeService.finishReason.test.js — 批1 stop_reason 信任(B 类原生直连补真值)。
 *
 * 此前 B 类原生直连(apiAdapter → multiFreeService)只解析 content + tool_calls,**从不读
 * finish_reason / stop_reason**,导致循环侧 aiResult.stopReason 在该路径恒为 null,
 * toolUseLoop 的 stop_reason 续跑保护/截断恢复在直连路径完全失效。
 *
 * 本套件锁定四条回填路径:
 *  - callOpenAI 非流式 → finishReason 来自 choices[0].finish_reason;
 *  - callOpenAI 非流式 tool_calls → finishReason='tool_calls' 且 toolUseBlocks 齐;
 *  - callAnthropic 非流式 → finishReason 来自 stop_reason;
 *  - generateResponse 把 callProvider 的 finishReason 串进 success 结果。
 *
 * 流式路径(SSE)的 finish_reason 捕获在 onChunk 分支,这里用非流式(无 onChunk)覆盖解析逻辑;
 * 流式回填与非流式同源(同一 finishReason 变量进 resolve),逻辑等价。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const MultiFreeService = require('../../src/services/multiFreeService');

const PROVIDER = { name: 'fake', model: 'm', apiKey: 'k' };

describe('multiFreeService 回填 native finish/stop reason', () => {
  let origPost;
  before(() => { origPost = axios.post; });
  after(() => { axios.post = origPost; });

  test('callOpenAI 非流式 → finishReason 来自 finish_reason', async () => {
    axios.post = async () => ({
      data: { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: {} },
    });
    const svc = new MultiFreeService();
    const res = await svc.callOpenAI(PROVIDER, 'hello', {});
    assert.equal(res.finishReason, 'stop');
    assert.equal(res.content, 'hi');
  });

  test('callOpenAI 非流式 tool_calls → finishReason=tool_calls 且 toolUseBlocks 齐', async () => {
    axios.post = async () => ({
      data: {
        choices: [{
          message: { content: '', tool_calls: [{ id: 't1', function: { name: 'Read', arguments: '{"path":"a"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: {},
      },
    });
    const svc = new MultiFreeService();
    const res = await svc.callOpenAI(PROVIDER, 'hello', {});
    assert.equal(res.finishReason, 'tool_calls');
    assert.ok(Array.isArray(res.toolUseBlocks) && res.toolUseBlocks.length === 1);
    assert.equal(res.toolUseBlocks[0].name, 'Read');
  });

  test('callAnthropic 非流式 → finishReason 来自 stop_reason', async () => {
    axios.post = async () => ({
      data: {
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const svc = new MultiFreeService();
    const res = await svc.callAnthropic({ ...PROVIDER, model: 'claude-3' }, 'hello', {});
    assert.equal(res.finishReason, 'end_turn');
  });

  test('generateResponse 把 finishReason 串进 success 结果', async () => {
    const svc = new MultiFreeService();
    svc.getAvailableProviders = () => [{ key: 'fake', name: 'fake', model: 'm', priority: 1, enabled: true }];
    svc.callProvider = async () => ({ content: 'done', finishReason: 'stop' });
    const res = await svc.generateResponse('hi', {});
    assert.equal(res.success, true);
    assert.equal(res.finishReason, 'stop');
  });

  test('缺 finish_reason 时 finishReason 为 null(向后兼容)', async () => {
    axios.post = async () => ({ data: { choices: [{ message: { content: 'hi' } }], usage: {} } });
    const svc = new MultiFreeService();
    const res = await svc.callOpenAI(PROVIDER, 'hello', {});
    assert.equal(res.finishReason, null);
  });
});
