'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const HANDLER = path.resolve(__dirname, '../../../src/cli/handlers/autofixPr.js');
const FORMATTERS = path.resolve(__dirname, '../../../src/cli/formatters.js');
const CI = path.resolve(__dirname, '../../../src/services/ciStatusService.js');
const LBS = path.resolve(__dirname, '../../../src/services/localBrainService.js');
const AFLOOP = path.resolve(__dirname, '../../../src/services/auditFixLoop/index.js');
const AGENT = path.resolve(__dirname, '../../../src/tools/AgentTool/index.js');

let infoLog, errLog, dispatchCalls;

function _stub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function _install({ ci, modelAvailable = false, afResult, agentExec } = {}) {
  _stub(FORMATTERS, {
    printInfo: (m) => infoLog.push(String(m)),
    printError: (m) => errLog.push(String(m)),
  });
  _stub(CI, { checkCIStatus: () => ci });
  _stub(LBS, { isModelAvailable: () => modelAvailable });
  _stub(AFLOOP, {
    runAuditFixCycle: async (opts) => {
      // 触发一次派发以验证注入链路。
      if (opts && typeof opts.dispatchAgent === 'function') {
        await opts.dispatchAgent({ role: 'audit', prompt: 'p', round: 1 });
      }
      return afResult || { outcome: 'clean', rounds: [], filesFixed: [], totalActionableRemaining: 0 };
    },
  });
  _stub(AGENT, {
    execute: async (...a) => { dispatchCalls.push(a); return agentExec || { output: 'ok', success: true, filesModified: [] }; },
  });
}

beforeEach(() => { infoLog = []; errLog = []; dispatchCalls = []; delete require.cache[HANDLER]; });
afterEach(() => {
  for (const p of [HANDLER, FORMATTERS, CI, LBS, AFLOOP, AGENT]) delete require.cache[p];
  delete process.env.KHY_AUTOFIX_PR;
});

test('门控关 → 不接管', async () => {
  process.env.KHY_AUTOFIX_PR = '0';
  _install({ ci: { classification: 'fail' } });
  const { handleAutofixPr } = require(HANDLER);
  assert.strictEqual(await handleAutofixPr('autofix-pr', [], {}), false);
});

test('status: 仅披露 CI 状态,不派发', async () => {
  _install({ ci: { platform: 'github', classification: 'fail', conclusion: 'failure' } });
  const { handleAutofixPr } = require(HANDLER);
  const took = await handleAutofixPr('autofix-pr', ['status'], {});
  assert.strictEqual(took, true);
  assert.match(infoLog.join('\n'), /CI 状态/);
  assert.strictEqual(dispatchCalls.length, 0);
});

test('run + CI fail + 模型可用 → 跑闭环并派发智能体', async () => {
  _install({
    ci: { platform: 'github', classification: 'fail', conclusion: 'failure' },
    modelAvailable: true,
    afResult: { outcome: 'fixed', rounds: [{ fixed: true, fixReport: { fixed: 1 } }], filesFixed: ['x.js'], totalActionableRemaining: 0 },
  });
  const { handleAutofixPr } = require(HANDLER);
  await handleAutofixPr('autofix-pr', [], {});
  assert.strictEqual(dispatchCalls.length, 1); // 闭环确实派发了一次
  assert.match(infoLog.join('\n'), /已自动修复/);
});

test('run + CI fail + 无模型 → 诚实降级,不派发', async () => {
  _install({ ci: { classification: 'fail' }, modelAvailable: false });
  const { handleAutofixPr } = require(HANDLER);
  await handleAutofixPr('autofix-pr', [], {});
  assert.strictEqual(dispatchCalls.length, 0);
  assert.match(infoLog.join('\n'), /无可用模型|Tier A/);
});

test('run + CI pass → 不修', async () => {
  _install({ ci: { classification: 'pass' }, modelAvailable: true });
  const { handleAutofixPr } = require(HANDLER);
  await handleAutofixPr('autofix-pr', [], {});
  assert.strictEqual(dispatchCalls.length, 0);
  assert.match(infoLog.join('\n'), /不执行修复/);
});

test('stop → 诚实说明无后台会话', async () => {
  _install({ ci: { classification: 'fail' } });
  const { handleAutofixPr } = require(HANDLER);
  await handleAutofixPr('autofix-pr', ['stop'], {});
  assert.match(infoLog.join('\n'), /没有后台云会话|同步前台/);
});

test('help → 帮助文本', async () => {
  _install({ ci: { classification: 'fail' } });
  const { handleAutofixPr } = require(HANDLER);
  await handleAutofixPr('autofix-pr', ['help'], {});
  assert.match(infoLog.join('\n'), /\/autofix-pr/);
});

test('CI 服务不可用 → 诚实错误,不崩', async () => {
  _stub(FORMATTERS, { printInfo: (m) => infoLog.push(String(m)), printError: (m) => errLog.push(String(m)) });
  _stub(CI, {}); // 无 checkCIStatus
  _stub(LBS, { isModelAvailable: () => false });
  const { handleAutofixPr } = require(HANDLER);
  const took = await handleAutofixPr('autofix-pr', ['status'], {});
  assert.strictEqual(took, true);
  assert.match(infoLog.join('\n'), /不可用/);
});
