'use strict';
/**
 * multiFreeService.streamUsage.test.js �?流式 usage 回流(�?agnes `0% ctx (0/128k)`)�?
 *
 * 两个真实缺陷,合起来导�?used token �?0:
 *  �?流式请求从不�?stream_options.include_usage �?标准 OpenAI 兼容网关(agnes)不回 usage;
 *  �?即便回了,usage 解析块原先排�?`if(!delta)continue` **之后**——�?include_usage �?
 *     usage-only 末块 `choices:[]`(delta undefined)�?�?continue 跳过,usage 丢失�?
 *
 * 本套件用�?SSE 流驱�?callOpenAI 流式分支,锁定:
 *  - 请求体带 stream_options.include_usage=true(缺陷①修�?;
 *  - usage-only 末块(choices �?也能读出 tokenUsage(缺陷②修�?;
 *  - 门控关时不带 stream_options(字节回退)�?
 */
const { Readable } = require('node:stream');
const MultiFreeService = require('../../src/services/multiFreeService');
const axios = MultiFreeService.httpClient;
const PROVIDER = { name: 'fake', model: 'agnes-2.0-flash', apiKey: 'k' };
/** 造一�?SSE 可读�?先若�?text delta �?末尾一�?usage-only �?choices �?,�?[DONE]�?*/
function sseStream(lines) {
  return Readable.from(lines.map(l => l + '\n\n'));
}
describe('multiFreeService 流式 usage 回流', () => {
  let origPost;
  before(() => { origPost = axios.post; });
  after(() => { axios.post = origPost; });
});

describe('Multi Free Service stream Usage', () => {
  test('缺陷�?流式请求体带 stream_options.include_usage=true', async () => {
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
        expect(captured).toBeTruthy();
        expect(captured.stream).toBe(true);
        assert.deepEqual(captured.stream_options, { include_usage: true });
  });

  test('缺陷�?usage-only 末块(choices �?也能读出 tokenUsage', async () => {
        axios.post = async () => ({ data: sseStream([
          'data: {"choices":[{"delta":{"content":"hello"}}]}',
          'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
          // include_usage �?usage-only 末块:choices 为空数组,usage 在顶�?
          'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":345,"total_tokens":1545}}',
          'data: [DONE]',
        ]) });
        const svc = new MultiFreeService();
        const res = await svc.callOpenAI(PROVIDER, 'hello', { onChunk() {} });
        expect(res.content).toBe('hello world');
        expect(res.tokenUsage).toBeTruthy();
        expect(res.tokenUsage.inputTokens).toBe(1200);
        expect(res.tokenUsage.outputTokens).toBe(345);
  });

  test('门控�?�?请求体不�?stream_options(字节回退)', async () => {
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
        expect(captured.stream_options).toBe(undefined);
  });

  test('向后兼容:usage 搭在 delta 块上(旧式)仍能读出', async () => {
        axios.post = async () => ({ data: sseStream([
          // 旧式:某些 provider �?usage 塞在�?delta 的末块里
          'data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
          'data: [DONE]',
        ]) });
        const svc = new MultiFreeService();
        const res = await svc.callOpenAI(PROVIDER, 'hello', { onChunk() {} });
        expect(res.tokenUsage).toBeTruthy();
        expect(res.tokenUsage.inputTokens).toBe(7);
        expect(res.tokenUsage.outputTokens).toBe(3);
  });

});

