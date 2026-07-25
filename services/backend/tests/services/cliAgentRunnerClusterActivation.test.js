'use strict';

/**
 * cliAgentRunner × toolClusterActivation 接线单测(#4 工具发现的最后一处本地缺口)。
 *
 * 背景:并行子代理分解路径(runAgents)此前是唯一「按 profile 过滤延迟工具、却不按子任务
 * 文本预激活工具簇」的本地路径——子代理拿到精简定义后须先 ToolSearch 才能发现能力,而关键词
 * 召回不稳。本接线把已在 worker/agentWorkerEntry 路径验证过的 selectToolsToActivate →
 * ensureTool 前摄揭示补到该路径。
 *
 * 覆盖:
 *   · 子任务文本命中能力簇(编译 / 配置模型密钥)→ runAgents 后对应延迟工具已全局揭示;
 *   · 无能力信号 → 不揭示任何延迟工具(低假阳,不无差别揭示);
 *   · 门控关(KHY_TOOL_CLUSTER_ACTIVATION=off)→ 逐字节回退,不预激活。
 *
 * runAgents 经 opts.ai 注入,chat 被 stub 掉,不发真实请求。揭示是全局的,经
 * registry.getRevealedDeferred() 直接观测。
 *
 * node:test。运行:`node --test tests/services/cliAgentRunnerClusterActivation.test.js`。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const runner = require('../../src/services/cliAgentRunner');
const reg = require('../../src/tools');

// stub aiModule:chat 立即返回,不发网络、不跑真实工具循环。
const _stubAi = {
  chat: async () => ({ reply: 'ok', tokenUsage: { totalTokens: 0 }, commands: [] }),
};

const ENV_KEYS = ['KHY_TOOL_CLUSTER_ACTIVATION', 'KHY_FLAG_REGISTRY'];
let _saved;

beforeEach(() => {
  _saved = {};
  for (const k of ENV_KEYS) { _saved[k] = process.env[k]; delete process.env[k]; }
  reg.resetDeferredSession();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (_saved[k] === undefined) delete process.env[k];
    else process.env[k] = _saved[k];
  }
  reg.resetDeferredSession();
});

describe('cliAgentRunner — 子任务文本预激活延迟工具簇(#4 缺口接线)', () => {
  test('编译信号 → runAgents 后 compile_file 已揭示', async () => {
    assert.strictEqual(reg.getRevealedDeferred().has('compile_file'), false, '前置:未揭示');
    await runner.runAgents(
      [{ task: '请编译 main.c 生成可执行文件', role: 'general', name: 't' }],
      { ai: _stubAi },
    );
    assert.strictEqual(reg.getRevealedDeferred().has('compile_file'), true, '编译簇应揭示 compile_file');
  });

  test('配置模型密钥信号 → configureModelProvider 已揭示', async () => {
    assert.strictEqual(reg.getRevealedDeferred().has('configureModelProvider'), false);
    await runner.runAgents(
      [{ task: '帮我配置模型供应商的 api key', role: 'general', name: 't' }],
      { ai: _stubAi },
    );
    assert.strictEqual(reg.getRevealedDeferred().has('configureModelProvider'), true);
  });

  test('无能力信号(闲聊)→ 不揭示任何延迟工具', async () => {
    await runner.runAgents(
      [{ task: '你好,今天心情不错', role: 'general', name: 't' }],
      { ai: _stubAi },
    );
    assert.strictEqual(reg.getRevealedDeferred().has('compile_file'), false);
    assert.strictEqual(reg.getRevealedDeferred().has('configureModelProvider'), false);
  });

  test('门控关(KHY_TOOL_CLUSTER_ACTIVATION=off)→ 逐字节回退,不预激活', async () => {
    process.env.KHY_TOOL_CLUSTER_ACTIVATION = 'off';
    await runner.runAgents(
      [{ task: '请编译 main.c 生成可执行文件', role: 'general', name: 't' }],
      { ai: _stubAi },
    );
    assert.strictEqual(reg.getRevealedDeferred().has('compile_file'), false, '门控关应不揭示');
  });
});
