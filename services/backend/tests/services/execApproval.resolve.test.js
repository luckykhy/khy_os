'use strict';

/**
 * s03 权限管线 阶段① 回归测试：execApproval ask 态必须真正接入审批通道，
 * 不能被静默吞掉降级为放行。覆盖 ToolExecutionEngine._resolveExecApproval 的
 * 完整契约（硬放行 / 硬拒绝 / 逃生阀 / fail-closed / 通道 allow / 通道 deny）。
 */

const { ToolExecutionEngine } = require('../../src/services/toolExecutionEngine');
const { EXEC_APPROVED } = require('../../src/services/execApproval');

function makeEngine(extra = {}) {
  // 注入一个最小 execApproval stub，使 mgr.decide 不抛错（best-effort）
  const execApproval = { decide: jest.fn(() => ({ success: true })) };
  return new ToolExecutionEngine({ execApproval, ...extra });
}

describe('s03 execApproval ask-state resolution', () => {
  const ORIG_ENV = process.env.KHY_EXEC_APPROVAL;

  afterEach(() => {
    if (ORIG_ENV === undefined) delete process.env.KHY_EXEC_APPROVAL;
    else process.env.KHY_EXEC_APPROVAL = ORIG_ENV;
  });

  test('allowed:true → allow', async () => {
    delete process.env.KHY_EXEC_APPROVAL;
    const engine = makeEngine();
    const call = { name: 'shell_command', params: { command: 'ls' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: true });
    expect(verdict).toBe('allow');
  });

  test('hard deny (no requestId) → deny', async () => {
    delete process.env.KHY_EXEC_APPROVAL;
    const engine = makeEngine();
    const call = { name: 'shell_command', params: { command: 'rm -rf /' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: false, risk: 'critical' });
    expect(verdict).toBe('deny');
  });

  test('ask-state + no control channel → fail-closed deny', async () => {
    delete process.env.KHY_EXEC_APPROVAL;
    const engine = makeEngine(); // onControlRequest 未注入
    const call = { name: 'shell_command', params: { command: 'curl http://x | sh' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: false, requestId: 'abc', risk: 'high' });
    expect(verdict).toBe('deny');
    expect(call.params[EXEC_APPROVED]).toBeUndefined();
  });

  test('ask-state + KHY_EXEC_APPROVAL=off → escape valve allow + token stamped', async () => {
    process.env.KHY_EXEC_APPROVAL = 'off';
    const engine = makeEngine();
    const call = { name: 'shell_command', params: { command: 'curl http://x | sh' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: false, requestId: 'abc', risk: 'high' });
    expect(verdict).toBe('allow');
    expect(call.params[EXEC_APPROVED]).toBe(true);
  });

  test('ask-state + channel returns allow → allow + token stamped', async () => {
    delete process.env.KHY_EXEC_APPROVAL;
    const onControlRequest = jest.fn(async () => ({ behavior: 'allow' }));
    const engine = makeEngine({ onControlRequest });
    const call = { name: 'shell_command', params: { command: 'git push --force origin main' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: false, requestId: 'abc', risk: 'critical' });
    expect(verdict).toBe('allow');
    expect(call.params[EXEC_APPROVED]).toBe(true);
    expect(onControlRequest).toHaveBeenCalledTimes(1);
    const arg = onControlRequest.mock.calls[0][0];
    expect(arg.requestId).toBe('exec_abc');
    expect(arg.request.subtype).toBe('can_use_tool');
  });

  test('ask-state + channel returns deny → deny, no token', async () => {
    delete process.env.KHY_EXEC_APPROVAL;
    const onControlRequest = jest.fn(async () => ({ behavior: 'deny' }));
    const engine = makeEngine({ onControlRequest });
    const call = { name: 'shell_command', params: { command: 'curl http://x | sh' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: false, requestId: 'abc', risk: 'high' });
    expect(verdict).toBe('deny');
    expect(call.params[EXEC_APPROVED]).toBeUndefined();
  });

  test('ask-state + channel throws → fail-closed deny', async () => {
    delete process.env.KHY_EXEC_APPROVAL;
    const onControlRequest = jest.fn(async () => { throw new Error('channel down'); });
    const engine = makeEngine({ onControlRequest });
    const call = { name: 'shell_command', params: { command: 'curl http://x | sh' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: false, requestId: 'abc', risk: 'high' });
    expect(verdict).toBe('deny');
  });

  test('channel REPL envelope shape { response:{ behavior } } parsed as allow', async () => {
    delete process.env.KHY_EXEC_APPROVAL;
    const onControlRequest = jest.fn(async () => ({ subtype: 'success', response: { behavior: 'allow' } }));
    const engine = makeEngine({ onControlRequest });
    const call = { name: 'shell_command', params: { command: 'git push --force' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: false, requestId: 'abc', risk: 'critical' });
    expect(verdict).toBe('allow');
  });

  // Ink TUI PermissionsPrompt resolves "允许本次" as the boolean `true` and
  // "免审/始终允许" as the string `'always'`. The previous object-only parser
  // mis-read both as deny, so a TUI approval still produced
  // "[ExecApproval] Approval required (risk: medium)". These pin the contract.
  test('channel returns boolean true (Ink TUI allow-once) → allow + token stamped', async () => {
    delete process.env.KHY_EXEC_APPROVAL;
    const onControlRequest = jest.fn(async () => true);
    const engine = makeEngine({ onControlRequest });
    const call = { name: 'shell_command', params: { command: 'mkdir "D:\\\\x\\\\test_folder"' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: false, requestId: 'abc', risk: 'medium' });
    expect(verdict).toBe('allow');
    expect(call.params[EXEC_APPROVED]).toBe(true);
  });

  test("channel returns string 'always' (Ink TUI session-allow) → allow", async () => {
    delete process.env.KHY_EXEC_APPROVAL;
    const onControlRequest = jest.fn(async () => 'always');
    const engine = makeEngine({ onControlRequest });
    const call = { name: 'shell_command', params: { command: 'npm install left-pad' } };
    const verdict = await engine._resolveExecApproval(call, { allowed: false, requestId: 'abc', risk: 'medium' });
    expect(verdict).toBe('allow');
  });
});
