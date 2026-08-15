const { sendWeChatNotification } = require('../../src/utils/notifier');

describe('sendWeChatNotification', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('returns false without a send key', async () => {
    expect(await sendWeChatNotification('', { signal: 'BUY', symbol: 'TEST' })).toBe(false);
  });

  test('posts JSON and returns true for ServerChan success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 0 }),
    });

    await expect(sendWeChatNotification('TOKEN', {
      signal: 'BUY',
      symbol: 'TEST',
      price: 12.5,
      confidence: 0.9,
      source: 'fixture',
    })).resolves.toBe(true);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://sctapi.ftqq.com/TOKEN.send');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(options.body)).toMatchObject({
      title: 'New Trading Signal — 买入 TEST',
    });
    expect(options.signal).toBeDefined();
  });

  test('returns false for business and HTTP errors', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 400 }) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

    await expect(sendWeChatNotification('TOKEN', { signal: 'HOLD', symbol: 'TEST' })).resolves.toBe(false);
    await expect(sendWeChatNotification('TOKEN', { signal: 'HOLD', symbol: 'TEST' })).resolves.toBe(false);
  });

  test('returns false for network errors', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('fixture network failure'));
    await expect(sendWeChatNotification('TOKEN', { signal: 'SELL', symbol: 'TEST' })).resolves.toBe(false);
  });
});
