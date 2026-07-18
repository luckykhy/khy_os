'use strict';

/**
 * toolCalling.sandboxEscape.test.js — 网关接线集成证（executeTool 漏斗）。
 *
 * 钉死「跳出沙箱执行 = L2 键入 YES」这条线在真实 executeTool 漏斗上的接线：
 *   1. 工具级声明 `sandboxEscape:true` 经 defineTool/register 透传 → 网关恒按 L2 裁决；
 *      无键入 YES 的宿主通道 → fail-closed 拦截（`_gatewayBlocked`/`denied`）。
 *   2. 宿主回传键入 YES（`{behavior:'allow', typed:'YES'}`）→ 越过网关、真正执行。
 *   3. 零回归：未声明逃逸的低危只读工具不被强升 L2 —— 逃逸声明（而非注册本身）才是触发器。
 *   4. 旁路零容忍：逃逸工具 + 模型参数夹带 force:true → 熔断 + 拒绝。
 *
 * 逃逸信号是工具级静态/动态声明，绝不取自模型参数（防呆①仍对参数 force 熔断）。
 */

// 与持久化权限规则隔离，使网关/权限逻辑被纯净测试。
process.env.KHY_PERMISSION_STORE = 'false';
process.env.KHY_SYSCALL_GATEWAY = 'on';

const tc = require('../../src/services/toolCalling');
const tools = require('../../src/tools');

// 宿主交互通道桩：可配置是否回传键入串。
const ctrlTyped = (typed) => async () => ({ behavior: 'allow', typed });
const ctrlAllowOnly = async () => ({ behavior: 'allow' }); // 不携带 typed（旧通道）
const ctrlNone = undefined;

beforeAll(() => {
  tc.setPermissionMode('default');
  // 注册四个夹具工具（经 register → defineTool 包装，验证 sandboxEscape 透传）。
  tools.register({
    name: '__esc_static__',
    description: 'fixture: static sandbox escape',
    risk: 'low',
    sandboxEscape: true,
    inputSchema: {},
    execute: async () => ({ ok: 'escaped' }),
  });
  tools.register({
    name: '__esc_dynamic__',
    description: 'fixture: dynamic sandbox escape',
    risk: 'low',
    isReadOnly: true, // baseline L0; only requiresSandboxEscape(params) pushes to L2
    requiresSandboxEscape: (p) => p && p.outside === true,
    inputSchema: { outside: { type: 'boolean' } },
    execute: async () => ({ ok: 'escaped-dyn' }),
  });
  tools.register({
    name: '__esc_plain_ro__',
    description: 'fixture: plain read-only, no escape',
    risk: 'low',
    isReadOnly: true,
    inputSchema: {},
    execute: async () => ({ ok: 'plain' }),
  });
});

afterAll(() => { tc.setPermissionMode('default'); });

describe('defineTool 透传逃逸声明', () => {
  test('静态 sandboxEscape 落到注册描述符', () => {
    expect(tools.get('__esc_static__').sandboxEscape).toBe(true);
  });
  test('动态 requiresSandboxEscape 落到注册描述符', () => {
    expect(typeof tools.get('__esc_dynamic__').requiresSandboxEscape).toBe('function');
    expect(tools.get('__esc_static__').requiresSandboxEscape).toBeUndefined();
  });
  test('未声明逃逸的工具 sandboxEscape 缺省 false', () => {
    expect(tools.get('__esc_plain_ro__').sandboxEscape).toBe(false);
  });
});

describe('executeTool 漏斗 — 逃逸工具恒 L2 键入 YES', () => {
  test('静态逃逸 + 无交互器 → fail-closed 网关拦截', async () => {
    const res = await tc.executeTool('__esc_static__', {}, { sessionId: 'esc_int_1', onControlRequest: ctrlNone });
    expect(res.denied).toBe(true);
    expect(res._gatewayBlocked).toBe(true);
  });

  test('静态逃逸 + 宿主仅 allow（无键入串）→ 仍拦截（不可旁路）', async () => {
    const res = await tc.executeTool('__esc_static__', {}, { sessionId: 'esc_int_2', onControlRequest: ctrlAllowOnly });
    expect(res.denied).toBe(true);
    expect(res._gatewayBlocked).toBe(true);
  });

  test('静态逃逸 + 键入 YES → 越过网关、真正执行', async () => {
    const res = await tc.executeTool('__esc_static__', {}, { sessionId: 'esc_int_3', onControlRequest: ctrlTyped('YES') });
    expect(res._gatewayBlocked).toBeUndefined();
    expect(res.denied).not.toBe(true);
  });

  test('动态逃逸：outside:true 触发 L2，无键入 YES → 拦截', async () => {
    const res = await tc.executeTool('__esc_dynamic__', { outside: true }, { sessionId: 'esc_int_4', onControlRequest: ctrlAllowOnly });
    expect(res.denied).toBe(true);
    expect(res._gatewayBlocked).toBe(true);
  });

  test('动态逃逸：outside 未置位 → 不强升 L2（低危只读照常）', async () => {
    const res = await tc.executeTool('__esc_dynamic__', { outside: false }, { sessionId: 'esc_int_5', onControlRequest: ctrlAllowOnly });
    expect(res._gatewayBlocked).toBeUndefined();
  });
});

describe('零回归 + 旁路零容忍', () => {
  test('未声明逃逸的低危只读工具不被强升 L2（逃逸声明才是触发器）', async () => {
    const res = await tc.executeTool('__esc_plain_ro__', {}, { sessionId: 'esc_int_6', onControlRequest: ctrlAllowOnly });
    expect(res._gatewayBlocked).toBeUndefined();
  });

  test('逃逸工具 + 参数夹带 force:true → 熔断拦截（即便回传 YES）', async () => {
    const res = await tc.executeTool('__esc_static__', { force: true }, { sessionId: 'esc_int_7', onControlRequest: ctrlTyped('YES') });
    expect(res.denied).toBe(true);
    expect(res._gatewayBlocked).toBe(true);
  });
});
