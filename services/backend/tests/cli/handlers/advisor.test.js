'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// 解析待 stub 的模块绝对路径(与 handler 内 require 路径一致)。
const HANDLER = path.resolve(__dirname, '../../../src/cli/handlers/advisor.js');
const FORMATTERS = path.resolve(__dirname, '../../../src/cli/formatters.js');
const GATEWAY = path.resolve(__dirname, '../../../src/cli/handlers/gateway.js');
const UCB = path.resolve(__dirname, '../../../src/services/gateway/ucbRouter.js');

let infoLog;
let errLog;

function _install({ choices = [], rankFn } = {}) {
  // formatters
  require.cache[FORMATTERS] = {
    id: FORMATTERS, filename: FORMATTERS, loaded: true, exports: {
      printInfo: (m) => infoLog.push(String(m)),
      printError: (m) => errLog.push(String(m)),
    },
  };
  // gateway: buildGatewayModelChoices
  require.cache[GATEWAY] = {
    id: GATEWAY, filename: GATEWAY, loaded: true, exports: {
      buildGatewayModelChoices: async () => ({
        modelChoices: choices,
        preferredIssueAfterProbe: null,
        empty: choices.length === 0,
      }),
    },
  };
  // ucbRouter: rank
  require.cache[UCB] = {
    id: UCB, filename: UCB, loaded: true, exports: {
      rank: rankFn || (() => []),
    },
  };
}

beforeEach(() => {
  infoLog = [];
  errLog = [];
  delete require.cache[HANDLER];
});
afterEach(() => {
  delete require.cache[HANDLER];
  delete require.cache[FORMATTERS];
  delete require.cache[GATEWAY];
  delete require.cache[UCB];
  delete process.env.KHY_ADVISOR_COMMAND;
});

test('门控关 → 不接管(返回 false)', async () => {
  process.env.KHY_ADVISOR_COMMAND = '0';
  _install();
  const { handleAdvisor } = require(HANDLER);
  const took = await handleAdvisor('advisor', [], {});
  assert.strictEqual(took, false);
});

test('recommend: 探测候选 + UCB 排名 → 推荐最高 value 的模型', async () => {
  _install({
    choices: [
      { name: '[可用] a-1', value: { adapter: 'alpha', model: 'a-1' } },
      { name: '[可用] b-1', value: { adapter: 'beta', model: 'b-1' } },
    ],
    rankFn: () => ([
      { adapter: 'beta', value: 0.9, mean: 0.8, pulls: 5 },
      { adapter: 'alpha', value: 0.3, mean: 0.2, pulls: 2 },
    ]),
  });
  const { handleAdvisor } = require(HANDLER);
  const took = await handleAdvisor('advisor', [], {});
  assert.strictEqual(took, true);
  const out = infoLog.join('\n');
  assert.match(out, /首选/);
  assert.match(out, /b-1/);
});

test('status: 透出实测均值/样本', async () => {
  _install({
    choices: [{ name: '[可用] a-1', value: { adapter: 'alpha', model: 'a-1' } }],
    rankFn: () => ([{ adapter: 'alpha', value: 0.5, mean: 0.6, pulls: 9 }]),
  });
  const { handleAdvisor } = require(HANDLER);
  await handleAdvisor('advisor', ['status'], {});
  assert.match(infoLog.join('\n'), /样本 9/);
});

test('无可执行候选 → 诚实空态(不抛)', async () => {
  _install({ choices: [], rankFn: () => [] });
  const { handleAdvisor } = require(HANDLER);
  const took = await handleAdvisor('advisor', [], {});
  assert.strictEqual(took, true);
  assert.match(infoLog.join('\n'), /无可推荐|无可执行/);
});

test('help → 帮助文本', async () => {
  _install();
  const { handleAdvisor } = require(HANDLER);
  await handleAdvisor('advisor', ['help'], {});
  assert.match(infoLog.join('\n'), /\/advisor/);
});

test('未知子命令 → printError + 仍接管', async () => {
  _install();
  const { handleAdvisor } = require(HANDLER);
  const took = await handleAdvisor('advisor', ['zzz'], {});
  assert.strictEqual(took, true);
  assert.match(errLog.join('\n'), /未知子命令/);
});

test('gateway/ucbRouter 缺失或抛 → best-effort 不崩(空候选诚实空态)', async () => {
  // 安装会抛的 gateway
  require.cache[FORMATTERS] = {
    id: FORMATTERS, filename: FORMATTERS, loaded: true, exports: {
      printInfo: (m) => infoLog.push(String(m)),
      printError: (m) => errLog.push(String(m)),
    },
  };
  require.cache[GATEWAY] = {
    id: GATEWAY, filename: GATEWAY, loaded: true, exports: {
      buildGatewayModelChoices: async () => { throw new Error('probe boom'); },
    },
  };
  require.cache[UCB] = {
    id: UCB, filename: UCB, loaded: true, exports: { rank: () => { throw new Error('rank boom'); } },
  };
  const { handleAdvisor } = require(HANDLER);
  const took = await handleAdvisor('advisor', [], {});
  assert.strictEqual(took, true);
  assert.match(infoLog.join('\n'), /无可推荐|无可执行/);
});
