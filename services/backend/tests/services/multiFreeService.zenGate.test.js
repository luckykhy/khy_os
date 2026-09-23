'use strict';

/**
 * multiFreeService zen headers — Zen endpoint injects free-gate fingerprint
 * headers and forces stream:true even without an onChunk callback.
 *
 * Uses the same multiFreeService.httpClient override pattern as streamUsage tests.
 */

const { Readable } = require('node:stream');
const MultiFreeService = require('../../src/services/multiFreeService');
const { ZEN_BASE_URL, _reset } = require('../../src/services/zenGatekeeper');
const axios = MultiFreeService.httpClient;

function sseStream(lines) {
  return Readable.from(lines.map((l) => l + '\n\n'));
}

describe('MultiFreeService Zen free gate', () => {
  let origPost;
  beforeAll(() => {
    origPost = axios.post;
  });
  afterAll(() => {
    axios.post = origPost;
  });

  beforeEach(() => {
    _reset();
    delete process.env.OPENCODE_CLIENT;
  });

  test('injects opencode fingerprint headers and forces stream=true', async () => {
    let captured = { url: null, body: null, headers: null };
    axios.post = async (url, body, config) => {
      captured = { url, body, headers: config && config.headers };
      return {
        data: sseStream([
          'data: {"choices":[{"delta":{"content":"hi"}}]}',
          'data: [DONE]',
        ]),
      };
    };

    const svc = new MultiFreeService();
    // No onChunk — Zen must still force the streaming path for the free gate.
    const provider = {
      name: 'opencode-zen',
      apiKey: 'public',
      baseUrl: ZEN_BASE_URL.replace(/\/v1$/, ''),
      model: 'claude-fable-5',
    };
    const res = await svc.callOpenAI(provider, 'hello', {});

    expect(captured.url).toContain('/v1/chat/completions');
    expect(captured.body.stream).toBe(true);
    expect(captured.headers['User-Agent']).toMatch(/^opencode\//);
    expect(captured.headers['x-opencode-session']).toMatch(/^ses_/);
    expect(captured.headers['x-opencode-client']).toBe('cli');
    expect(captured.headers.Authorization).toBe('Bearer public');
    expect(res.content).toBe('hi');
  });

  test('non-Zen endpoints do not get the fingerprint headers', async () => {
    let captured = { headers: null };
    axios.post = async (url, body, config) => {
      captured = { headers: config && config.headers };
      return {
        data: sseStream(['data: [DONE]']),
      };
    };

    const svc = new MultiFreeService();
    const provider = {
      name: 'other',
      apiKey: 'sk-x',
      baseUrl: 'https://example.com',
      model: 'm',
    };
    await svc.callOpenAI(provider, 'hello', { onChunk() {} });

    expect(captured.headers['x-opencode-session']).toBeUndefined();
    expect(captured.headers.Authorization).toBe('Bearer sk-x');
  });
});
