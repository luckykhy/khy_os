'use strict';

/**
 * breakerResetOnNew.test.js — 会话清空(/new · /reset · /clear · 双 Ctrl+C)顺带清熔断器回归。
 *
 * 背景:系统调用网关的会话级一击熔断是**会话粘滞**的——误判旁路标记(如已修复前的裸 -f)一旦
 * 触发,`/new`/`/reset`/`/clear` 只清对话历史却不清熔断,用户只能重启进程恢复。本轮把
 * gateway.resetSession()/resetAllSessions() 接进会话清空接缝(门控 KHY_BREAKER_RESET_ON_NEW
 * 默认开),让误锁可经 /new 自愈。
 *
 * 本测直接验证网关侧的 reset 语义(REPL 接线是薄壳,已由 node -c + 手工 E2E 覆盖)。
 */

const { describe, test, expect } = require('@jest/globals');
const gateway = require('../../src/services/syscallGateway');

// 用旁路注入标记(force:true 在命令承载字段)触发零容忍一击熔断,拿到「已跳闸」的会话。
async function tripBreaker(sessionId) {
  // command 字段里带 force:true 键 → detectBypassMarkers 命中 → 一击熔断。
  await gateway.evaluate({
    sessionId,
    tool: 'ShellCommand',
    params: { command: 'do it', force: true },
  }, {});
}

describe('breaker reset — 熔断后 resetSession 使会话恢复未跳闸', () => {
  test('触发熔断 → inspect().tripped=true;resetSession 后 inspect()=null(会话被清)', async () => {
    const sid = 'test-reset-session-a';
    await tripBreaker(sid);
    const before = gateway.inspect(sid);
    expect(before).toBeTruthy();
    expect(before.tripped).toBe(true);

    gateway.resetSession(sid);
    // resetSession 删除整会话 → inspect 返 null(下次 evaluate 会新建一个未跳闸会话)。
    expect(gateway.inspect(sid)).toBeNull();
  });

  test('熔断后新调用仍被全拒(证明确实跳闸);reset 后同 sessionId 不再被熔断拒', async () => {
    const sid = 'test-reset-session-b';
    await tripBreaker(sid);
    // 跳闸后连一个普通只读调用也应被熔断拒(熔断优先于一切)。
    const blocked = await gateway.evaluate({
      sessionId: sid, tool: 'Read', params: { path: 'x.txt' }, isReadOnly: true,
    }, {});
    expect(blocked.allow).toBe(false);
    expect(blocked.tripped).toBe(true);

    gateway.resetSession(sid);
    // reset 后同名会话是全新的:只读调用不再因熔断被拒(L0 直接放行)。
    const after = await gateway.evaluate({
      sessionId: sid, tool: 'Read', params: { path: 'x.txt' }, isReadOnly: true,
    }, {});
    expect(after.tripped).toBe(false);
    expect(after.allow).toBe(true);
  });
});

describe('breaker reset — resetAllSessions 清空进程内全部会话(CLI /new 用)', () => {
  test('多个会话各自跳闸 → resetAllSessions 后全部 inspect()=null', async () => {
    const ids = ['test-all-1', 'test-all-2', 'test-all-3'];
    for (const id of ids) await tripBreaker(id);
    for (const id of ids) expect(gateway.inspect(id).tripped).toBe(true);

    const n = gateway.resetAllSessions();
    expect(n).toBeGreaterThanOrEqual(ids.length);
    for (const id of ids) expect(gateway.inspect(id)).toBeNull();
  });

  test('resetAllSessions 绝不抛,空表返回 0', () => {
    gateway.resetAllSessions(); // 先清空
    expect(() => gateway.resetAllSessions()).not.toThrow();
    expect(gateway.resetAllSessions()).toBe(0);
  });
});

describe('sessionClear 共享叶子 — REPL 与 TUI /clear 共用的 breaker-reset SSOT', () => {
  const { resetGatewayBreakerOnSessionClear } = require('../../src/cli/sessionClear');

  test('门控 KHY_BREAKER_RESET_ON_NEW 关(off/0/false/no/disable/disabled)→ 返 false 且不复位', async () => {
    const sid = 'test-leaf-gate-off';
    for (const v of ['off', '0', 'false', 'no', 'disable', 'disabled', 'OFF', 'False']) {
      await tripBreaker(sid);
      // 门控关:叶子不复位,返回 false;跳闸态保留。
      const ran = resetGatewayBreakerOnSessionClear({ KHY_BREAKER_RESET_ON_NEW: v });
      expect(ran).toBe(false);
      expect(gateway.inspect(sid)).toBeTruthy();
      expect(gateway.inspect(sid).tripped).toBe(true);
      gateway.resetSession(sid); // 清理,进入下一轮
    }
  });

  test('门控开(默认/空/任意非关值)→ 复位跳闸会话使 inspect()=null', async () => {
    // 默认(未设 env)= 开。
    const sidA = 'test-leaf-default';
    await tripBreaker(sidA);
    expect(gateway.inspect(sidA).tripped).toBe(true);
    const ranDefault = resetGatewayBreakerOnSessionClear({});
    expect(ranDefault).toBe(true);
    expect(gateway.inspect(sidA)).toBeNull();

    // 显式开(on/1/true 之外任意非关值)= 开。
    const sidB = 'test-leaf-on';
    await tripBreaker(sidB);
    expect(gateway.inspect(sidB).tripped).toBe(true);
    const ranOn = resetGatewayBreakerOnSessionClear({ KHY_BREAKER_RESET_ON_NEW: 'on' });
    expect(ranOn).toBe(true);
    expect(gateway.inspect(sidB)).toBeNull();
  });

  test('绝不抛(即便 env 为异常值/缺失)', () => {
    expect(() => resetGatewayBreakerOnSessionClear(undefined)).not.toThrow();
    expect(() => resetGatewayBreakerOnSessionClear(null)).not.toThrow();
    expect(() => resetGatewayBreakerOnSessionClear({ KHY_BREAKER_RESET_ON_NEW: 123 })).not.toThrow();
  });
});
