'use strict';

describe('webSearchService queue-empty retry', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('retries once when Kiro returns queue empty and then succeeds', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        error: { code: -32000, message: 'queue is empty' },
      })
      .mockResolvedValueOnce({
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              results: [
                {
                  title: 'Latest AI News',
                  url: 'https://example.com/ai-news',
                  snippet: 'Summary...',
                },
              ],
            }),
          }],
        },
      });

    const createSDKClient = jest.fn(async () => ({ send }));
    const destroy = jest.fn();

    jest.doMock('../src/services/gateway/adapters/kiroAdapter', () => ({
      detect: jest.fn(() => true),
      getAccessToken: jest.fn(async () => ({ profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/test' })),
      createSDKClient,
      getCWModule: jest.fn(async () => ({
        InvokeMCPCommand: function InvokeMCPCommand(input) { this.input = input; },
        MCPMethod: { TOOLS_CALL: 'tools/call' },
      })),
      destroy,
    }));

    const svc = require('../src/services/webSearchService');
    const result = await svc.searchDirect('latest ai news');

    expect(result.success).toBe(true);
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results[0].title).toBe('Latest AI News');
    expect(send).toHaveBeenCalledTimes(2);
    expect(createSDKClient).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

