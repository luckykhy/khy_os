'use strict';

/**
 * multiFreeService.streamUsage.test.js — 流式 usage 回流(修 agnes `0% ctx (0/128k)`)。
 *
 * 两个真实缺陷,合起来导致 used token 卡 0:
 *  ① 流式请求从不带 stream_options.include_usage → 标准 OpenAI 兼容网关(agnes)不回 usage;
 *  ② 即便回了,usage 解析块原先排在 `if(!delta)continue` **之后**——而 include_usage 的
 *     usage-only 末块 `choices:[]`(delta undefined)→ 被 continue 跳过,usage 丢失。
 *
 * 本套件用假 SSE 流驱动 callOpenAI 流式分支,锁定:
 *  - 请求体带 stream_options.include_usage=true(缺陷①修复);
 *  - usage-only 末块(choices 空)也能读出 tokenUsage(缺陷②修复);
 *  - 门控关时不带 stream_options(字节回退)。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const axios = require('axios');

const MultiFreeService = require('../../src/services/multiFreeService');
const PROVIDER = { name: 'fake', model: 'agnes-2.0-flash', apiKey: 'k' };

/** 造一条 SSE 可读流:先若干 text delta 块,末尾一个 usage-only 块(choices 空),再 [DONE]。 */
function sseStream(lines) {
  return Readable.from(lines.map(l => l + '\n\n'));
}

describe('multiFreeService 流式 usage 回流', () => {
  let origPost;
  before(() => { origPost = axios.post; });
  after(() => { axios.post = origPost; });

  test('缺陷①:流式请求体带 stream_options.include_usage=true', async () => {
    let captured = null;
    axios.post = async (url, body) => {
      captured = body;
      return { data: sseStream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        'data: [DONE]',
      ]) };
    };
    const svc = new MultiFreeService();
    await svc.callOpenAI(PROVIDER, 'hello', { onChunk() {} });
    assert.ok(captured, '应捕获到请求体');
    assert.equal(captured.stream, true);
    assert.deepEqual(captured.stream_options, { include_usage: true });
  });

  test('缺陷②:usage-only 末块(choices 空)也能读出 tokenUsage', async () => {
    axios.post = async () => ({ data: sseStream([
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
      // include_usage 的 usage-only 末块:choices 为空数组,usage 在顶层
      'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":345,"total_tokens":1545}}',
      'data: [DONE]',
    ]) });
    const svc = new MultiFreeService();
    const res = await svc.callOpenAI(PROVIDER, 'hello', { onChunk() {} });
    assert.equal(res.content, 'hello world');
    assert.ok(res.tokenUsage, 'usage-only 末块应被解析出 tokenUsage(非 null)');
    assert.equal(res.tokenUsage.inputTokens, 1200);
    assert.equal(res.tokenUsage.outputTokens, 345);
  });

  test('门控关 → 请求体不带 stream_options(字节回退)', async () => {
    let captured = null;
    axios.post = async (url, body) => {
      captured = body;
      return { data: sseStream(['data: [DONE]']) };
    };
    const svc = new MultiFreeService();
    const origEnv = process.env.KHY_STREAM_USAGE;
    process.env.KHY_STREAM_USAGE = 'off';
    try {
      await svc.callOpenAI(PROVIDER, 'hello', { onChunk() {} });
    } finally {
      if (origEnv === undefined) delete process.env.KHY_STREAM_USAGE;
      else process.env.KHY_STREAM_USAGE = origEnv;
    }
    assert.equal(captured.stream_options, undefined, '门控关不应带 stream_options');
  });

  test('向后兼容:usage 搭在 delta 块上(旧式)仍能读出', async () => {
    axios.post = async () => ({ data: sseStream([
      // 旧式:某些 provider 把 usage 塞在带 delta 的末块里
      'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
      'data: [DONE]',
    ]) });
    const svc = new MultiFreeService();
    const res = await svc.callOpenAI(PROVIDER, 'hello', { onChunk() {} });
    assert.ok(res.tokenUsage);
    assert.equal(res.tokenUsage.inputTokens, 7);
    assert.equal(res.tokenUsage.outputTokens, 3);
  });
});
