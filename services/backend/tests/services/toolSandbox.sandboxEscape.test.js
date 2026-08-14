'use strict';

/**
 * toolSandbox.sandboxEscape.test.js — safe-by-construction 硬化证。
 *
 * 「跳出 OS 沙箱 / 全权执行」是系统级提权。本套钉死两条不变量：
 *   1. `_shouldSkipOsSandbox`：裸 `_skipOsSandbox` 永不足以关沙箱，必须额外携带由 syscall
 *      网关签发的 `_sandboxEscapeApproved` 凭据。
 *   2. `routeCommand`：临界命令的逃逸执行器（`executor:'direct'`/full-access）只在携带网关
 *      逃逸凭据时放行；本地 TTL escalation 账本命中也不够。`autoApprove` 永不产出逃逸
 *      （只对 dangerous 自动放行，executor 仍 'sandbox'）。
 *
 * 零外部依赖、零真实执行：仅对路由/谓词这两层纯决策断言。
 */

const sandbox = require('../../src/services/toolSandbox');

describe('_shouldSkipOsSandbox — 裸 _skipOsSandbox 不足以关沙箱', () => {
  test('无任何标记 → false', () => {
    expect(sandbox._shouldSkipOsSandbox({})).toBe(false);
    expect(sandbox._shouldSkipOsSandbox(undefined)).toBe(false);
  });
  test('裸 _skipOsSandbox=true（无网关凭据） → 仍 false（继续沙箱）', () => {
    expect(sandbox._shouldSkipOsSandbox({ _skipOsSandbox: true })).toBe(false);
  });
  test('仅有凭据但未请求跳过 → false', () => {
    expect(sandbox._shouldSkipOsSandbox({ _sandboxEscapeApproved: true })).toBe(false);
  });
  test('_skipOsSandbox + 网关逃逸凭据齐备 → true', () => {
    expect(sandbox._shouldSkipOsSandbox({ _skipOsSandbox: true, _sandboxEscapeApproved: true })).toBe(true);
  });
});

describe('routeCommand — 临界逃逸须带网关凭据', () => {
  const CRITICAL = 'sudo rm -rf /tmp/x'; // classifyCommand → critical
  const DANGEROUS = 'git push --force';  // classifyCommand → dangerous

  test('临界命令即便本地账本批准，无网关逃逸凭据 → blocked（不逃逸）', () => {
    const userId = 'esc_test_user_1';
    // 先在本地 TTL 账本批准该临界命令（旧的弱授权）。
    sandbox.approveEscalation({ command: CRITICAL, tier: 'critical', userId, scope: 'command' });
    const r = sandbox.routeCommand(CRITICAL, { userId }); // 无 _sandboxEscapeApproved
    expect(r.executor).toBe('blocked');
    expect(r.approved).toBe(false);
    expect(r.needsApproval).toBe(true);
    expect(r.approvalReason).toBe('sandbox_escape_requires_gateway');
  });

  test('临界命令 + 网关逃逸凭据 + 账本批准 → direct（受控逃逸）', () => {
    const userId = 'esc_test_user_2';
    sandbox.approveEscalation({ command: CRITICAL, tier: 'critical', userId, scope: 'command' });
    const r = sandbox.routeCommand(CRITICAL, { userId, _sandboxEscapeApproved: true });
    expect(r.executor).toBe('direct');
    expect(r.approved).toBe(true);
  });

  test('临界命令未获任何批准 → blocked（与逃逸凭据无关）', () => {
    const r = sandbox.routeCommand(CRITICAL, { userId: 'esc_test_user_3' });
    expect(r.executor).toBe('blocked');
  });

  test('autoApprove 永不产出逃逸：dangerous 自动放行仍走 sandbox', () => {
    const r = sandbox.routeCommand(DANGEROUS, { userId: 'esc_test_user_4', autoApprove: true });
    expect(r.executor).toBe('sandbox');
    expect(r.approved).toBe(true);
  });

  test('safe 命令照常 sandbox（逃逸硬化不影响低危路由）', () => {
    const r = sandbox.routeCommand('ls -la', { userId: 'esc_test_user_5' });
    expect(r.executor).toBe('sandbox');
    expect(r.approved).toBe(true);
  });
});

describe('evaluateSandboxEscape — 委托唯一审批权威（fail-closed）', () => {
  test('无交互器（非交互） → not approved', async () => {
    const out = await sandbox.evaluateSandboxEscape(
      { sessionId: 'esc_eval_1', tool: 'shell_command', params: { command: 'ls' } },
      {},
    );
    expect(out.approved).toBe(false);
  });

  test('键入 YES → approved（经网关 L2）', async () => {
    const out = await sandbox.evaluateSandboxEscape(
      { sessionId: 'esc_eval_2', tool: 'shell_command', params: { command: 'ls' } },
      { prompter: { confirmL2: async () => 'YES' } },
    );
    expect(out.approved).toBe(true);
    expect(out.level).toBe('L2');
  });
});
