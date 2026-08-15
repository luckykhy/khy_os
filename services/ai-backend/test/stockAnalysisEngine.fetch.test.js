'use strict';

describe('stockAnalysisEngine fetch transport', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetModules();
  });

  function loadWithFetch(mockFetch) {
    global.fetch = mockFetch;
    let engine;
    jest.isolateModules(() => {
      engine = require('../src/services/stockAnalysisEngine');
    });
    return engine;
  }

  test('marks the engine online after a successful connectivity response', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const engine = loadWithFetch(mockFetch);
    await engine.checkNetworkStatus();

    expect(engine.isOnline).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://www.baidu.com', {
      signal: expect.any(AbortSignal),
    });
  });

  test('marks the engine offline after an HTTP or network error', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const engine = loadWithFetch(mockFetch);
    await engine.checkNetworkStatus();
    expect(engine.isOnline).toBe(false);

    mockFetch.mockRejectedValueOnce(new Error('fixture network failure'));
    await engine.checkNetworkStatus();
    expect(engine.isOnline).toBe(false);
  });

  test('parses a Sina quote response', async () => {
    const quote = 'var hq_str_sh600000="浦发银行,10.00,9.50,10.20,10.50,9.80,0,0,12345,67890,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0";';
    const mockFetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => quote });
    const engine = loadWithFetch(mockFetch);

    const result = await engine.fetchFromSina('600000');
    expect(result).toMatchObject({
      name: '浦发银行',
      price: 10.2,
      close: 9.5,
      changePercent: '7.37',
      volume: 12345,
      amount: 67890,
    });
    expect(mockFetch.mock.calls[1][0]).toBe('https://hq.sinajs.cn/list=s_sh600000');
    expect(mockFetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });
});
