'use strict';

/**
 * Tests for services/commandDispatchPort.js — the neutral port that breaks the
 * keystone `services/toolCalling.js → cli/router.js` reverse edge
 * (DESIGN-ARCH-021, Batch 1).
 *
 * Pure unit tests: deterministic, offline, zero external dependencies. The port
 * is a true leaf (no requires), so these never load the CLI layer.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');

const port = require('../../src/services/commandDispatchPort');

describe('commandDispatchPort', () => {
  beforeEach(() => port._resetForTest());

  test('未注册时 getDispatcher 返回 null（消费方据此优雅降级）', () => {
    assert.strictEqual(port.getDispatcher(), null);
  });

  test('注册后 getDispatcher 取回同一 dispatcher，parseInput/route 可达', async () => {
    const calls = [];
    const dispatcher = {
      parseInput: (line) => { calls.push(['parse', line]); return { line }; },
      route: async (parsed) => { calls.push(['route', parsed.line]); return 'ok'; },
    };
    port.registerDispatcher(dispatcher);

    const got = port.getDispatcher();
    assert.strictEqual(got, dispatcher, '取回的是注册的同一对象');

    // 复刻 toolCalling SlashCommand 处理器的调用契约
    const parsed = got.parseInput('/help');
    const result = await got.route(parsed);
    assert.strictEqual(result, 'ok');
    assert.deepStrictEqual(calls, [['parse', '/help'], ['route', '/help']]);
  });

  test('registerDispatcher(null) 清空注册（回到降级态）', () => {
    port.registerDispatcher({ parseInput() {}, route() {} });
    assert.ok(port.getDispatcher());
    port.registerDispatcher(null);
    assert.strictEqual(port.getDispatcher(), null);
  });

  test('registerDispatcher(undefined) 归一为 null，不抛', () => {
    port.registerDispatcher();
    assert.strictEqual(port.getDispatcher(), null);
  });

  test('_resetForTest 清空注册', () => {
    port.registerDispatcher({ parseInput() {}, route() {} });
    port._resetForTest();
    assert.strictEqual(port.getDispatcher(), null);
  });

  test('端口是零依赖叶子（导出仅三个函数，无副作用 require）', () => {
    assert.deepStrictEqual(
      Object.keys(port).sort(),
      ['_resetForTest', 'getDispatcher', 'registerDispatcher'],
    );
  });
});
