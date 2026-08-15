'use strict';

const { callCloudAI, postProvider } = require('../src/routes/ai');

describe('ai provider fetch transport', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('posts JSON and parses a provider response', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ result: 'ok' }), { status: 200 }));

    const result = await postProvider('https://TARGET/provider', { prompt: 'fixture' }, {
      headers: { Authorization: 'Bearer TOKEN' },
    });

    expect(result).toEqual({ data: { result: 'ok' } });
    expect(global.fetch).toHaveBeenCalledWith('https://TARGET/provider', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer TOKEN' },
      body: JSON.stringify({ prompt: 'fixture' }),
      signal: expect.any(AbortSignal),
    }));
  });

  test('sends Baidu credentials as form data', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await postProvider('https://TARGET/token', null, {
      params: { grant_type: 'client_credentials', client_secret: 'TOKEN' },
    });

    expect(global.fetch.mock.calls[0][1]).toMatchObject({
      body: 'grant_type=client_credentials&client_secret=TOKEN',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  });

  test('maps non-2xx responses to an error', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));
    await expect(postProvider('https://TARGET/provider', {})).rejects.toThrow('Provider API HTTP 502');
  });

  test('keeps OpenAI response extraction and provider failover contract', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'fixture answer' } }],
    }), { status: 200 }));

    await expect(callCloudAI('600000', { confidence: 80 }, 'fixture question', { openai: 'TOKEN' }))
      .resolves.toBe('fixture answer');
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
  });
});
