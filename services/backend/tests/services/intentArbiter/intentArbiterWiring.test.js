'use strict';

/**
 * intentArbiterWiring.test.js — intentArbiter 接入 executeTool 单漏斗的端到端验收
 * （[DESIGN-ARCH-041] 前置意图路由）。
 *
 * `.ai/GUARDS-AI.md` §0 铁律：「隔离单测全绿 ≠ 在产」。intentArbiter 的隔离单测见
 * `intentArbiter.test.js`；本文件证明它从真实执行入口 `toolCalling.executeTool` **可达**，
 * 并在前置位真正裁决：
 *   ①KHY_INTENT_ARBITER=on + 意图落安全对话带 → 拦截（denied，_intentArbiterBlocked）；
 *   ②同上 + 意图落指令执行带 → 不被意图层拦截（放行至既有管线）；
 *   ③同上 + 无 intentText → 零介入（对既有调用方零回归）；
 *   ④开关默认关 → 即便对话带意图也零介入。
 *   ⑤歧义模糊带 + 交互通道批准 → 放行；拒绝 → 拦截（防呆②）。
 *
 * 用真实注册的只读工具 `ls`（cwd 下相对路径），不依赖其成败——只断言「意图层是否拦截」，
 * 与 frictionBridge.test.js 的端到端用例同法（命中真正的接入点而非更早的早退/网关 deny）。
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolCalling = require('../../../src/services/toolCalling');

const PREV = process.env.KHY_INTENT_ARBITER;
afterEach(() => {
  if (PREV === undefined) delete process.env.KHY_INTENT_ARBITER;
  else process.env.KHY_INTENT_ARBITER = PREV;
});

const CHAT_INTENT = '你好啊今天天气怎么样';      // 置信度 0.1 → 安全对话带
const EXEC_INTENT = '立即执行系统扫描';          // 置信度 0.95 → 指令执行带
const CONFIRM_INTENT = '看看本地模式';           // 置信度 0.5 → 歧义模糊带
const LS_PATH = '.';                            // cwd，存在即可（不依赖成败）

describe('intentArbiter — 接入 executeTool 前置意图路由（端到端）', () => {
  test('①on + 对话带意图 → 拦截（防误触）', async () => {
    process.env.KHY_INTENT_ARBITER = 'on';
    const r = await toolCalling.executeTool('ls', { path: LS_PATH }, {
      sessionId: 'intent-e2e-chat', intentText: CHAT_INTENT,
    });
    assert.equal(r && r._intentArbiterBlocked, true, '对话带意图应被前置拦截');
    assert.equal(r.denied, true);
    assert.equal(r.success, false);
  });

  test('②on + 执行带意图 → 不被意图层拦截（放行）', async () => {
    process.env.KHY_INTENT_ARBITER = 'on';
    const r = await toolCalling.executeTool('ls', { path: LS_PATH }, {
      sessionId: 'intent-e2e-exec', intentText: EXEC_INTENT,
    });
    assert.notEqual(r && r._intentArbiterBlocked, true, '执行带意图绝不应被意图层拦截');
  });

  test('③on + 无 intentText → 零介入（既有调用方零回归）', async () => {
    process.env.KHY_INTENT_ARBITER = 'on';
    const r = await toolCalling.executeTool('ls', { path: LS_PATH }, { sessionId: 'intent-e2e-none' });
    assert.notEqual(r && r._intentArbiterBlocked, true, '无原始意图时意图层必须零介入');
  });

  test('④开关默认关 → 对话带意图也零介入', async () => {
    delete process.env.KHY_INTENT_ARBITER;
    const r = await toolCalling.executeTool('ls', { path: LS_PATH }, {
      sessionId: 'intent-e2e-off', intentText: CHAT_INTENT,
    });
    assert.notEqual(r && r._intentArbiterBlocked, true, '开关关闭时即便对话带意图也不得拦截');
  });

  test('⑤歧义带 + 交互通道批准 → 放行；拒绝 → 拦截（防呆②）', async () => {
    process.env.KHY_INTENT_ARBITER = 'on';

    const allowResp = await toolCalling.executeTool('ls', { path: LS_PATH }, {
      sessionId: 'intent-e2e-confirm-yes',
      intentText: CONFIRM_INTENT,
      onControlRequest: async () => ({ behavior: 'allow' }),
    });
    assert.notEqual(allowResp && allowResp._intentArbiterBlocked, true, '用户确认后歧义带应放行');

    const denyResp = await toolCalling.executeTool('ls', { path: LS_PATH }, {
      sessionId: 'intent-e2e-confirm-no',
      intentText: CONFIRM_INTENT,
      onControlRequest: async () => ({ behavior: 'deny' }),
    });
    assert.equal(denyResp && denyResp._intentArbiterBlocked, true, '用户拒绝后歧义带必须拦截（防呆②）');

    const noChanResp = await toolCalling.executeTool('ls', { path: LS_PATH }, {
      sessionId: 'intent-e2e-confirm-nochan',
      intentText: CONFIRM_INTENT,
    });
    assert.equal(noChanResp && noChanResp._intentArbiterBlocked, true, '无交互通道时歧义带 fail-closed 拦截');
  });
});
