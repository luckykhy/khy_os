'use strict';

const service = require('../src/services/modelTrainingService');

describe('createRemoteRepo fetch transport', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('creates a private GitHub repository with bearer auth', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201 });
    await service.createRemoteRepo('github', 'fixture-repo', 'TOKEN');

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/user/repos');
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer TOKEN',
      },
    });
    expect(JSON.parse(options.body)).toEqual({
      name: 'fixture-repo',
      private: true,
      description: 'KHY-Quant trained model',
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test('creates a private Gitee repository with token in the JSON body', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 201 });
    await service.createRemoteRepo('gitee', 'fixture-repo', 'TOKEN');

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://gitee.com/api/v5/user/repos');
    expect(JSON.parse(options.body)).toMatchObject({ access_token: 'TOKEN', name: 'fixture-repo' });
    expect(options.headers.Authorization).toBeUndefined();
  });

  test('does not request unknown platforms', async () => {
    global.fetch = jest.fn();
    await service.createRemoteRepo('other', 'fixture-repo', 'TOKEN');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('preserves fail-soft behavior for HTTP and network errors', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockRejectedValueOnce(new Error('fixture network failure'));

    await expect(service.createRemoteRepo('github', 'fixture-repo', 'TOKEN')).resolves.toBeUndefined();
    await expect(service.createRemoteRepo('gitee', 'fixture-repo', 'TOKEN')).resolves.toBeUndefined();
  });
});
