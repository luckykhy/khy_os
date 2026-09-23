'use strict';

/**
 * claudeAdapter 权限判定 → control_response 映射（BUG-19b/19e）。
 *
 * 活体主诉：ink 权限弹窗按 Esc 拒绝后，Claude CLI 子进程里的 Skill **照样执行了 2m39s**。
 * 根因不在弹窗（`PermissionsPrompt.js` 的 `onResolve(false)` 是对的），而在
 * `normalizeControlResponse`：它把「不是对象」一律当成「没人应答」，于是原始值
 * `false` 走进了 `buildDefaultControlResponse` 的 auto-allow 兜底 —— 拒绝被改写成放行。
 *
 * 这条契约此前**零测试**（本目录 grep 无命中），所以补的是判据本身：
 * TUI 用原始值、REPL 宿主用 `{behavior}` 对象，两条通道都必须落到正确的
 * control_response；读不懂的判定一律 **deny**（判错的代价是执行用户拒绝的工具）。
 *
 * 复现/复诊存证：.khy/feedback/tui-ux-audit-20260919/S/
 */

const adapter = require('../../src/services/gateway/adapters/claudeAdapter');
const { _decisionFromControl } = require('../../src/services/tool/toolCallingPermissions');

const { normalizeControlResponse, buildDefaultControlResponse } = adapter.__test__;

// 活体报告里被误放行的那一次：L2 灾急性红灯，工具 Skill。
const CAN_USE_TOOL = {
  subtype: 'can_use_tool',
  tool_name: 'Skill',
  input: { skill: 'claude-api' },
};

const REQ_ID = 'req-0001';

const behaviorOf = (envelope) => envelope && envelope.response && envelope.response.response
  && envelope.response.response.behavior;

describe('can_use_tool 判定值 → 发给 Claude CLI 的 response', () => {
  test('TUI 的 Esc 拒绝（原始值 false）必须是 deny —— 曾经被改写成 allow', () => {
    const env = normalizeControlResponse(REQ_ID, CAN_USE_TOOL, false);
    expect(behaviorOf(env)).toBe('deny');
    // CLI 的 schema 对 deny 要求 message；与经典 REPL 宿主用同一句话。
    expect(env.response.response.message).toBe('Permission denied');
    expect(env.response.request_id).toBe(REQ_ID);
    expect(env.response.subtype).toBe('success');
  });

  test('TUI 的同意（原始值 true / "always" / "allow-always"）都是 allow', () => {
    for (const verdict of [true, 'always', 'allow-always']) {
      const env = normalizeControlResponse(REQ_ID, CAN_USE_TOOL, verdict);
      expect(behaviorOf(env)).toBe('allow');
      // allow 必须带 updatedInput —— 缺了 CLI 侧 Zod 报错，表现为「权限组件有问题」。
      expect(env.response.response.updatedInput).toEqual({ skill: 'claude-api' });
    }
  });

  test('读不懂的判定一律 deny（不许落到 auto-allow 兜底）', () => {
    for (const junk of ['', 0, 'yep', 'no', NaN, -1]) {
      expect(behaviorOf(normalizeControlResponse(REQ_ID, CAN_USE_TOOL, junk))).toBe('deny');
    }
  });

  test('真的没人应答（null / undefined）仍走文档化的 auto-allow 兜底', () => {
    // 非交互 gateway 模式下 onControlRequest 缺席；此处拒绝会让子进程空等。
    for (const noAnswer of [null, undefined]) {
      expect(normalizeControlResponse(REQ_ID, CAN_USE_TOOL, noAnswer))
        .toEqual(buildDefaultControlResponse(REQ_ID, CAN_USE_TOOL));
    }
  });

  test('经典 REPL 宿主的对象形状逐字节不变（改判定分支不能碰坏它们）', () => {
    const shapes = [
      [{ behavior: 'deny', message: 'Critical operation denied' }, 'deny'],
      [{ behavior: 'allow', typed: 'confirm' }, 'allow'],
      [{ behavior: 'discuss' }, 'discuss'],
      // 内层 {subtype, response} 与整封 envelope 两种包装
      [{ subtype: 'success', response: { behavior: 'deny', message: 'x' } }, 'deny'],
      [{
        type: 'control_response',
        response: { request_id: REQ_ID, response: { behavior: 'allow', updatedInput: {} } },
      }, 'allow'],
    ];
    for (const [raw, expected] of shapes) {
      const before = JSON.stringify(raw);
      const env = normalizeControlResponse(REQ_ID, CAN_USE_TOOL, raw);
      expect(behaviorOf(env)).toBe(expected);
      expect(JSON.stringify(raw)).toBe(before); // 不改写入参
    }
  });

  test('与规范判读器 _decisionFromControl 结论一致（真源只有一个）', () => {
    // 适配器不得自己再拼一份「什么算允许」的表；一旦分叉，同一判定在 native
    // 路径与子进程路径会给出相反结果（正是本条 bug 的形态）。
    const DENY_DEFAULT = 'allow'; // no-answer 兜底由 buildDefaultControlResponse 负责，不参与对齐
    for (const verdict of [true, false, 'always', 'allow-always', '', 0, 'yes', null]) {
      const decision = _decisionFromControl(verdict);
      const env = normalizeControlResponse(REQ_ID, CAN_USE_TOOL, verdict);
      if (verdict === null || verdict === undefined) {
        expect(behaviorOf(env)).toBe(DENY_DEFAULT);
        continue;
      }
      // allow-always 在 CLI 协议里没有对应值，落到本轮 allow。
      expect(behaviorOf(env)).toBe(decision === 'deny' ? 'deny' : 'allow');
    }
  });

  test('非 can_use_tool 的子类型不受本次改动影响', () => {
    const env = normalizeControlResponse(REQ_ID, { subtype: 'initialize' }, false);
    expect(env.response.response).toEqual({});
    expect(behaviorOf(env)).toBeUndefined();
  });
});
