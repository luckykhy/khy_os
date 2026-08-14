'use strict';

/**
 * toolCalling.intentArbiterWiring.test.js — 意图裁决「消费侧」端到端集成([DESIGN-ARCH-041])。
 *
 * 背景:确定性意图裁决器(intentArbiter)是**无模型 / 无网络**也能跑的纯词法防误触层
 * (CJK bigram + 词法规则,零 IO、零网络、零模型)。它在 toolCalling.executeTool 漏斗里、
 * 一切能力/网关裁决**之前**对「触发本次执行的原始自然语言意图」做三段路由:
 *   execution 强意图 → 放行;chat 安全对话带 → 拦截(防误触);confirm 歧义带 → 无确认通道则拦截(防呆②)。
 *
 * 它只在 `traceContext.intentText` 携带原始 NL 且 `KHY_INTENT_ARBITER=on` 时介入。
 * 本测试注册一个 risk:'safe'(自动放行 → 直达校验 + handler)的合成 builtin,经真实
 * `executeTool` 漏斗验证消费侧契约:
 *   - 门控开 + chat 带意图 → 工具被拦截(_intentArbiterBlocked),handler 绝不执行;
 *   - 门控开 + execution 带意图 → 放行,handler 执行;
 *   - 门控开 + 无 intentText → 零介入(zero-intrusion),handler 执行;
 *   - 门控关(默认)+ chat 带意图 → 逐字节回退,arbiter 整段跳过,handler 照常执行。
 *
 * 生产侧(toolUseLoop 把 originalUserMessage 线进 traceContext.intentText)由
 * toolUseLoop.intentTextWiring.test.js 单独覆盖;两者合起来证明「NL → 确定性裁决」闭环。
 */

const toolCalling = require('../../src/services/toolCalling');

const TOOL = '__intent_arbiter_probe__';
let ran = false;

beforeAll(() => {
  toolCalling.registerTool({
    name: TOOL,
    description: 'test-only intent-arbiter wiring probe',
    risk: 'safe', // 自动放行,使非投机路径直达校验 + handler(arbiter 仍在网关之前裁决)
    parameters: {},
    handler: async () => { ran = true; return { success: true, output: 'ran' }; },
  });
});

const SAVED = {};
// 隔离系统调用网关 / 持久权限库 / 人审门:它们各有独立放行路径,与本测试考查的
// 「意图裁决前置路由」正交。只留 executeTool 漏斗自身 + arbiter 段。
const ENV_KEYS = ['KHY_INTENT_ARBITER', 'KHY_SYSCALL_GATEWAY', 'KHY_PERMISSION_STORE', 'KHY_HUMAN_GATE'];
beforeEach(() => {
  ran = false;
  for (const k of ENV_KEYS) SAVED[k] = process.env[k];
  process.env.KHY_SYSCALL_GATEWAY = 'off';
  process.env.KHY_PERMISSION_STORE = 'false';
  process.env.KHY_HUMAN_GATE = 'off';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

// 自指疑问 → 安全对话带(arbiter 单测锁定 band=CHAT、confidence≤0.2)。
const CHAT_INTENT = '你是什么模型';
// 特权动词 + 目标 + 强调 → 指令执行带(arbiter 单测锁定 band=EXECUTION、confidence≥0.7)。
const EXEC_INTENT = '我明确要求进入本地模式';

describe('intentArbiter — executeTool 消费侧端到端', () => {
  test('门控开 + chat 带意图 → 拦截,handler 绝不执行(防误触)', async () => {
    process.env.KHY_INTENT_ARBITER = 'on';
    const res = await toolCalling.executeTool(TOOL, {}, { intentText: CHAT_INTENT });
    expect(res.success).toBe(false);
    expect(res._intentArbiterBlocked).toBe(true);
    expect(res.denied).toBe(true);
    expect(ran).toBe(false);
  });

  test('门控开 + execution 带意图 → 放行,handler 执行', async () => {
    process.env.KHY_INTENT_ARBITER = 'on';
    const res = await toolCalling.executeTool(TOOL, {}, { intentText: EXEC_INTENT });
    expect(res.success).toBe(true);
    expect(res._intentArbiterBlocked).toBeUndefined();
    expect(ran).toBe(true);
  });

  test('门控开 + 无 intentText → 零介入,handler 执行(对未接线调用方零回归)', async () => {
    process.env.KHY_INTENT_ARBITER = 'on';
    const res = await toolCalling.executeTool(TOOL, {}, {}); // 不带 intentText
    expect(res.success).toBe(true);
    expect(res._intentArbiterBlocked).toBeUndefined();
    expect(ran).toBe(true);
  });

  test('门控关(默认)+ chat 带意图 → 逐字节回退,arbiter 整段跳过,handler 照常执行', async () => {
    delete process.env.KHY_INTENT_ARBITER; // 默认关
    const res = await toolCalling.executeTool(TOOL, {}, { intentText: CHAT_INTENT });
    expect(res.success).toBe(true);
    expect(res._intentArbiterBlocked).toBeUndefined();
    expect(ran).toBe(true);
  });
});
