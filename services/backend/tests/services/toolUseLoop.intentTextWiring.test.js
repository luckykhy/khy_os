'use strict';

/**
 * toolUseLoop.intentTextWiring.test.js — 意图裁决「生产侧」接线集成([DESIGN-ARCH-041])。
 *
 * 证明 runToolUseLoop 在调用 toolCalling.executeTool 时,把**原始人类自然语言**
 * (originalUserMessage)线进 traceContext.intentText —— 这是让无模型/无网络的确定性
 * 意图裁决器真正可达的「数据生产者」。此前 intentText 在全仓库无任何赋值方,故
 * KHY_INTENT_ARBITER=on 也是死开关。
 *
 * 手法:猴补 toolCalling.executeTool 为一个**捕获 traceContext 并立即成功返回**的桩
 * (因此真实漏斗里的网关/审批/arbiter 都不参与——本测试只考查「字段是否被线进来」),
 * 用 fake chat 发一次结构化 toolUseBlocks 触发一次工具执行,断言桩收到的
 * traceContext.intentText === 原始 userMessage。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const toolCalling = require('../../src/services/toolCalling');
const toolUseLoop = require('../../src/services/toolUseLoop');

const PROBE = '__producer_probe__';

describe('toolUseLoop — intentText 生产侧接线', () => {
  let _origExec;
  let _savedGate;
  let captured;

  beforeEach(() => {
    captured = [];
    _savedGate = process.env.KHY_TASK_CAPABILITY_GATE;
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    // 注册一个 risk:'safe' 合成工具,避免被投机预取/意图过滤当成未知危险调用丢弃。
    toolCalling.registerTool({
      name: PROBE,
      description: 'test-only producer probe',
      risk: 'safe',
      parameters: {},
      handler: async () => ({ success: true, output: 'handler-ran' }),
    });
    // 猴补 executeTool:捕获第三参 traceContext,立即成功返回(绕过真实漏斗内部一切裁决)。
    _origExec = toolCalling.executeTool;
    toolCalling.executeTool = async (name, params, ctx) => {
      captured.push({ name, intentText: ctx && ctx.intentText });
      return { success: true, output: 'stub' };
    };
  });

  afterEach(() => {
    toolCalling.executeTool = _origExec;
    if (_savedGate === undefined) delete process.env.KHY_TASK_CAPABILITY_GATE;
    else process.env.KHY_TASK_CAPABILITY_GATE = _savedGate;
  });

  test('executeTool 收到的 traceContext.intentText === 原始 userMessage', async () => {
    const USER_MSG = '请运行检查工具处理这个任务';
    let turn = 0;
    const chat = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          toolUseBlocks: [{ name: PROBE, input: {}, id: 'tu_producer_1' }],
          stopReason: 'tool_use',
          reply: '',
          provider: 'mock',
        };
      }
      return { reply: '完成。', stopReason: 'stop', provider: 'mock' };
    };

    await toolUseLoop.runToolUseLoop(USER_MSG, { chat, maxIterations: 4 });

    const probeCalls = captured.filter((c) => c.name === PROBE);
    assert.ok(probeCalls.length >= 1, `合成工具应至少被执行一次,实得 ${JSON.stringify(captured)}`);
    assert.equal(probeCalls[0].intentText, USER_MSG,
      `executeTool 应收到原始 NL 作为 intentText,实得 ${JSON.stringify(probeCalls[0].intentText)}`);
  });
});
