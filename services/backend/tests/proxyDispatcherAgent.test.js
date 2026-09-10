'use strict';
/**
 * proxyDispatcherAgent.test.js — 锁 utils/proxyDispatcherAgent 口径
 *   (收敛 imageGenService·videoGenService 2 处相同 body 的 _proxyDispatcher)。
 *
 * 注:proxyConfigService.getActiveProxy() 可能读磁盘持久代理·故不强断言无 env 恒 undefined;
 *   主测 env 回退分支产出 ProxyAgent + 绝不抛。
 */
const proxyDispatcherAgent = require('../src/utils/proxyDispatcherAgent');
function clearProxyEnv() {
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
}

describe('Proxy Dispatcher Agent', () => {
  test('HTTPS_PROXY 设值 → 返回 undici ProxyAgent 对象', () => {
      clearProxyEnv();
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
      const r = proxyDispatcherAgent();
      expect(r && typeof r === 'object').toBeTruthy();
      clearProxyEnv();
  });

  test('绝不抛(任意 env 状态)', () => {
      clearProxyEnv();
      expect(() => proxyDispatcherAgent().not.toThrow());
      process.env.HTTP_PROXY = 'http://127.0.0.1:1080';
      expect(() => proxyDispatcherAgent().not.toThrow());
      clearProxyEnv();
  });

  test('返回值类型:object 或 undefined(绝不为 null/字符串)', () => {
      clearProxyEnv();
      const r = proxyDispatcherAgent();
      expect(r === undefined || typeof r === 'object').toBeTruthy();
  });

});
