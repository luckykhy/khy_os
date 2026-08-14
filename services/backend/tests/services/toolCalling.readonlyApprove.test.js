'use strict';

/**
 * toolCalling.readonlyApprove.test.js — Part A「只读默认批准」回归。
 *
 * requestPermission 新增「只读默认放行」子句：动态自报 isReadOnly:true 且非破坏性的
 * 工具默认放行，不再打断用户。严格不弱化保护：
 *   - 关键红线(criticalGate)永远先行，只读子句够不到它；
 *   - 策略 confirm 仍强制弹窗；
 *   - 动态破坏性参数令其失效；
 *   - 杀手开关 KHY_AUTO_APPROVE_READONLY=off 整体退化回原交互流程。
 *
 * 为隔离本子句，测试关闭系统调用网关与持久化权限库（它们各有独立的放行路径），
 * 只考查 requestPermission 漏斗自身的行为。注册两个合成工具（只读/非只读，均为
 * medium 风险，故不会被既有 safe/low 自动放行兜住，专门暴露本子句）。
 */

const reg = require('../../src/tools');
const tc = require('../../src/services/toolCalling');

const SAVED = {};
const ENV_KEYS = ['KHY_SYSCALL_GATEWAY', 'KHY_PERMISSION_STORE', 'KHY_AUTO_APPROVE_READONLY', 'KHY_HUMAN_GATE'];

const RO = '__t_ro_probe_a';
const RW = '__t_rw_probe_a';
const DESTRUCTIVE = '__t_del_probe_a';

beforeAll(() => {
  reg.register({
    name: RO, description: 'read-only probe', risk: 'medium', category: 'filesystem',
    isReadOnly: () => true, isDestructive: () => false,
    parameters: { type: 'object', properties: {} }, execute: async () => ({}),
  });
  reg.register({
    name: RW, description: 'writing probe', risk: 'medium', category: 'filesystem',
    isReadOnly: () => false, isDestructive: () => false,
    parameters: { type: 'object', properties: {} }, execute: async () => ({}),
  });
  reg.register({
    name: DESTRUCTIVE, description: 'destructive probe', risk: 'medium', category: 'filesystem',
    isReadOnly: () => false, isDestructive: () => true,
    parameters: { type: 'object', properties: {} }, execute: async () => ({}),
  });
});

beforeEach(() => {
  for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; }
  // Isolate the requestPermission funnel from the gateway + permission store.
  process.env.KHY_SYSCALL_GATEWAY = 'off';
  process.env.KHY_PERMISSION_STORE = 'false';
  delete process.env.KHY_AUTO_APPROVE_READONLY;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('Part A — 只读默认批准', () => {
  test('动态只读的 medium 工具默认放行（无需弹窗）', async () => {
    const decision = await tc.requestPermission(RO, {});
    expect(decision).toBe('allow');
  });

  test('KHY_AUTO_APPROVE_READONLY=off → 退回交互流程（弹窗拒绝则拒绝）', async () => {
    process.env.KHY_AUTO_APPROVE_READONLY = 'off';
    const decision = await tc.requestPermission(RO, {}, async () => 'deny');
    expect(decision).toBe('deny');
  });

  test('非只读 medium 工具不被本子句放行（仍走交互）', async () => {
    const decision = await tc.requestPermission(RW, {}, async () => 'deny');
    expect(decision).toBe('deny');
  });

  test('破坏性工具不被只读子句放行（防御纵深：isDestructive 取消资格）', async () => {
    const decision = await tc.requestPermission(DESTRUCTIVE, {}, async () => 'deny');
    expect(decision).toBe('deny');
  });
});
