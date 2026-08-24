'use strict';

/**
 * multiFreeService.providerProxyUnreachable.test.js — BUG-005 回归。
 *
 * Symptom: every model failed with a bare `connect ECONNREFUSED <proxy>`, right
 * after a log line claiming the per-provider proxy tunnel was already
 * established ("通道已建立"). Two defects combined:
 *
 *   1. `_agentForProviderProxy` logged "通道已建立" immediately after
 *      `new HttpsProxyAgent(url)`. That constructor performs NO I/O — the real
 *      TCP/CONNECT handshake only happens on the first request — so the claim
 *      was unconditionally false and pointed triage at the upstream/apikey.
 *   2. The per-provider proxy branch of `postWithDeadConnRetry` only retried on
 *      dead-connection errors. It had no "proxy unreachable → fall back to
 *      direct" path (unlike the global HTTPS_PROXY branch), so a stopped local
 *      proxy client took down every provider with an unattributed error.
 *
 * Fix: log the binding as "尚未建连", and on ECONNREFUSED-family errors fall back
 * to a direct connection once, naming the dead proxy endpoint if that also fails.
 */

const net = require('net');

const MultiFreeService = require('../../src/services/multiFreeService');

// Reserve a port and immediately release it, so nothing is listening on it.
// Using an ephemeral port keeps the test free of hard-coded port literals and
// immune to whatever the developer happens to be running locally.
function unusedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function providerWithDeadProxy(proxyPort, upstreamPort) {
  return {
    name: 'OpenAI',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    baseUrl: `https://127.0.0.1:${upstreamPort}`,
    proxy: `http://127.0.0.1:${proxyPort}`,
  };
}

describe('BUG-005 per-provider 代理不可达', () => {
  test('绑定代理时不再声称「通道已建立」，而是标注尚未建连', async () => {
    const [proxyPort, upstreamPort] = await Promise.all([unusedPort(), unusedPort()]);
    const logs = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        new MultiFreeService().callOpenAI(providerWithDeadProxy(proxyPort, upstreamPort), 'hi', {
          model: 'gpt-4o-mini',
          timeoutMs: 5000,
        })
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }

    const bindLine = logs.find((l) => l.includes('[proxy]') && l.includes(String(proxyPort)));
    expect(bindLine).toBeTruthy();
    // 核心断言：构造 agent 阶段没有任何 I/O，绝不能宣称通道已建立。
    expect(bindLine).not.toMatch(/通道已建立/);
    expect(bindLine).toMatch(/尚未建连/);
    // 状态透明：动作 + 目标 + 进度（host:port）。
    expect(bindLine).toContain(`127.0.0.1:${proxyPort}`);
  });

  test('代理未监听时回退直连；直连也失败则错误点名该代理端点', async () => {
    const [proxyPort, upstreamPort] = await Promise.all([unusedPort(), unusedPort()]);
    const warnings = [];
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((...a) => warnings.push(a.join(' ')));

    let caught = null;
    try {
      await new MultiFreeService().callOpenAI(
        providerWithDeadProxy(proxyPort, upstreamPort),
        'hi',
        { model: 'gpt-4o-mini', timeoutMs: 5000 }
      );
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(caught).toBeTruthy();
    // 回退直连确实发生过，并且日志点名了不可达的代理端点。
    const fallbackLine = warnings.find((l) => l.includes(`127.0.0.1:${proxyPort}`));
    expect(fallbackLine).toBeTruthy();
    expect(fallbackLine).toMatch(/未监听/);
    expect(fallbackLine).toMatch(/回退直连/);

    // 直连也失败时，最终 message 必须解释真实起因，而不是只丢一条裸 ECONNREFUSED。
    expect(caught.message).toMatch(/未监听/);
    expect(caught.message).toContain(`127.0.0.1:${proxyPort}`);
  });

  test('未配置 proxy 的 provider 不打任何 per-provider 代理日志', async () => {
    const upstreamPort = await unusedPort();
    const logs = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        new MultiFreeService().callOpenAI(
          {
            name: 'OpenAI',
            apiKey: 'sk-test',
            model: 'gpt-4o-mini',
            baseUrl: `https://127.0.0.1:${upstreamPort}`,
          },
          'hi',
          { model: 'gpt-4o-mini', timeoutMs: 5000 }
        )
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
    expect(logs.some((l) => l.includes('per-provider 代理'))).toBe(false);
  });
});
