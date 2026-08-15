'use strict';

jest.mock('../../src/utils/nativeHttp', () => ({
  request: jest.fn(),
}));

const { request } = require('../../src/utils/nativeHttp');
const { callCloudAI, postProvider } = require('../../src/routes/ai');

describe('backend AI provider native HTTP transport', () => {
  afterEach(() => {
    request.mockReset();
    jest.restoreAllMocks();
  });

  test('posts JSON and parses a provider response', async () => {
    request.mockResolvedValue({ status: 200, data: { result: 'ok' } });

    const result = await postProvider('https://TARGET/provider', { prompt: 'fixture' }, {
      headers: { Authorization: 'Bearer TOKEN' },
    });

    expect(result).toEqual({ data: { result: 'ok' } });
    expect(request).toHaveBeenCalledWith('https://TARGET/provider', {
      method: 'POST',
      headers: { Authorization: 'Bearer TOKEN' },
      body: JSON.stringify({ prompt: 'fixture' }),
      timeoutMs: 15000,
    });
  });

  test('sends Baidu credentials as form data', async () => {
    request.mockResolvedValue({ status: 200, data: {} });

    await postProvider('https://TARGET/token', null, {
      form: { grant_type: 'client_credentials', client_secret: 'TOKEN' },
    });

    expect(request.mock.calls[0][1]).toMatchObject({
      body: 'grant_type=client_credentials&client_secret=TOKEN',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  });

  test('maps non-2xx responses to an error', async () => {
    request.mockResolvedValue({ status: 502, data: 'bad gateway' });
    await expect(postProvider('https://TARGET/provider', {})).rejects.toThrow(
      'Provider API HTTP 502'
    );
  });

  test('keeps Gemini key out of the URL', async () => {
    request.mockResolvedValue({
      status: 200,
      data: { candidates: [{ content: { parts: [{ text: 'fixture answer' }] } }] },
    });

    await expect(callCloudAI('600000', { confidence: 80 }, 'fixture question', {
      google: 'TOKEN',
    })).resolves.toBe('fixture answer');

    const [url, options] = request.mock.calls[0];
    expect(url).not.toContain('TOKEN');
    expect(options.headers['x-goog-api-key']).toBe('TOKEN');
  });
});
